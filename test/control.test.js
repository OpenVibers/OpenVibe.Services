'use strict';
// Control operations (ADR-048, plan T13 step 10): POST /api/v1/resources/control takes a common.resource-control-request@1
// behind services.resource.control, resolves the owning authority from the OVRN (or the resource_kind for create),
// forwards it through openvibe-sdk/resources' createResourceClient with a token scoped to that authority's
// <id>.resource.control, and answers its common.resource-control-result@1. It is idempotent on idempotency_key
// (services_control_log), an authority without a control endpoint answers failed resources.authority_unsupported, and
// every accepted request leaves one services_audit row. The gate for sensitive actions is test/control-confirmations.test.js.
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const { serviceAuth, ids, resources } = require('openvibe-contracts');
const { createAuthorities } = require('../server/authorities');
const { boot, check, done } = require('./helpers/boot');

/** A media authority with a control endpoint; /watch/… answers 404 like an authority that has none. */
async function startAuthority() {
    const seen = [];
    let network = null;
    let listed = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
            // The index, for the console's resources page: what `listed` holds.
            if (req.method === 'GET' && req.url.startsWith('/api/v1/resources')) return send(200, { resources: listed, next_cursor: null });
            if (req.url !== '/api/v1/resources/control' || req.method !== 'POST') return send(404, { type: 'about:blank', title: 'Not found', status: 404, code: 'route.not_found' });
            const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
            const v = serviceAuth.verifyServiceToken(token, { publicKey: network.publicPem, issuer: network.url, audience: 'openvibe.media' });
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            seen.push({ body, claims: v.ok ? v.claims : null });
            if (!v.ok || !(v.claims.cap || []).includes('media.resource.control')) return send(403, { type: 'about:blank', title: 'Forbidden', status: 403, code: 'capability.denied' });
            const at = new Date().toISOString();
            if (body.action === 'create') {
                const ovrn = resources.format({ service: 'media', project_id: body.project_id, type: 'object', id: ids.newId('media') });
                return send(200, { action: 'create', resource: ovrn, state: 'done', result: { id: ovrn.split('/').pop() }, at });
            }
            if (body.action === 'start') return send(202, { action: 'start', resource: body.resource, state: 'pending', at });
            if (body.action === 'rotate') {
                return send(200, { action: 'rotate', resource: resources.format({ service: 'media', project_id: ids.newId('project'), type: 'object', id: ids.newId('media') }), state: 'done', at });
            }
            if (body.action === 'stop') {
                return send(409, { action: 'stop', resource: body.resource, state: 'refused', confirmation_required: { confirmation_id: 'media-cnf-1', reason: 'the authority asks' }, at });
            }
            return send(200, { action: body.action, resource: body.resource, state: 'done', result: { applied: body.action }, at });
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return {
        url: `http://127.0.0.1:${server.address().port}`, seen,
        bind(n) { network = n; },
        list(rows) { listed = rows; },
        close: () => new Promise((r) => server.close(r)),
    };
}

const authority = (id, origin, control) => Object.freeze({
    id, name: id, internalOrigin: origin, publicOrigin: null, audience: `openvibe.${id}`, capability: `${id}.resource.read`,
    control, manifestVersion: '0.1.0', contractsRange: null, status: 'alpha',
});
function registryOf(list) {
    const byId = new Map(list.map((a) => [a.id, a]));
    return { list: () => [...byId.values()], get: (id) => byId.get(id) || null, ids: () => [...byId.keys()], size: () => byId.size };
}

(async () => {
    const media = await startAuthority();
    const t = await boot({
        authorities: registryOf([
            authority('media', media.url, 'media.resource.control'),
            authority('watch', `${media.url}/watch`, 'watch.resource.control'),
            authority('events', 'http://127.0.0.1:9', null),
        ]),
    });
    media.bind(t.network);
    const db = t.ctx.store.db;

    const token = (cap, { sub = 'svc:actor', aud = 'openvibe.services', extra = {} } = {}) => {
        const now = Math.floor(Date.now() / 1000);
        return serviceAuth.signServiceToken({ iss: t.network.url, sub, actor_type: sub.startsWith('app:') ? 'app' : 'service', aud: [aud], cap, iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(8).toString('hex')}`, ...extra }, t.network.privatePem);
    };
    const svc = `Bearer ${token(['services.resource.control'])}`;
    const control = (body, authorization = svc) => t.get('/api/v1/resources/control', { json: body, headers: authorization ? { authorization } : {} });
    const key = () => `ctl-${crypto.randomBytes(8).toString('hex')}`;
    const audits = async () => db.many('SELECT * FROM services_audit ORDER BY id');
    const valid = (r) => { const c = resources.checkControlResult(r); assert.ok(c.valid, JSON.stringify(c.errors)); };

    const prj = ids.newId('project');
    const object = resources.format({ service: 'media', project_id: prj, type: 'object', id: ids.newId('media') });

    await check('only an authority with an active <id>.resource.control takes control requests (Watch 0.165, Events 0.168, Actor and Media 0.169, Space 0.170, Zone 0.173)', async () => {
        const real = createAuthorities(t.config, { log: { warn() {} } });
        assert.ok(real.size() > 0);
        // Person-owned resources too since 0.176.0: bot, chat, openre and community (ADR-048 amendment 2026-10-15).
        const TAKES = { watch: 'watch.resource.control', events: 'events.resource.control', actor: 'actor.resource.control', media: 'media.resource.control', space: 'space.resource.control', zone: 'zone.resource.control',
            bot: 'bot.resource.control', chat: 'chat.resource.control', openre: 'openre.resource.control', community: 'community.resource.control' };
        for (const a of real.list()) assert.strictEqual(a.control, TAKES[a.id] || null, `${a.id}: the control capability in the pinned contracts`);
    });

    await check('the gate: anonymous 401, no capability 403, an app token 403, a malformed request 400 — nothing forwarded', async () => {
        const body = { action: 'update', resource: object, project_id: prj, idempotency_key: key() };
        assert.strictEqual((await control(body, null)).status, 401);
        const noCap = await control(body, `Bearer ${token(['services.resource.read'])}`);
        assert.strictEqual(noCap.status, 403);
        const app = await control(body, `Bearer ${token(['services.resource.control'], { sub: `app:${ids.newId('app')}`, extra: { project_id: prj, ns: [prj], env: 'production' } })}`);
        assert.strictEqual(app.status, 403, app.text);
        assert.strictEqual(app.json().code, 'capability.denied');
        for (const bad of [
            { action: 'delete', project_id: prj, idempotency_key: key() },                                        // no resource
            { action: 'update', resource: object, project_id: ids.newId('project'), idempotency_key: key() },       // another project
            { action: 'create', resource_kind: 'media.object', project_id: prj },                                   // no key
            { action: 'explode', resource: object, project_id: prj, idempotency_key: key() },
        ]) {
            const r = await control(bad);
            assert.strictEqual(r.status, 400, JSON.stringify(bad));
            assert.strictEqual(r.json().code, 'control.bad_request');
            assert.ok(Array.isArray(r.json().errors) && r.json().errors.length);
        }
        assert.strictEqual(media.seen.length, 0);
        assert.strictEqual((await audits()).length, 0, 'a refused request is not a control request');
    });

    await check('create, update and delete are forwarded to the owning authority with its control token; its answer is returned', async () => {
        const created = await control({ action: 'create', resource_kind: 'media.object', project_id: prj, idempotency_key: key(), params: { name: 'clip.mp4' } });
        assert.strictEqual(created.status, 200, created.text);
        valid(created.json());
        assert.strictEqual(created.json().state, 'done');
        assert.strictEqual(resources.parse(created.json().resource).project_id, prj);
        const sent = media.seen.at(-1);
        assert.strictEqual(sent.body.resource_kind, 'media.object');
        assert.deepStrictEqual(sent.body.params, { name: 'clip.mp4' });
        assert.deepStrictEqual(sent.claims.cap, ['media.resource.control'], 'the token is scoped to the authority\'s own control capability');
        assert.strictEqual(sent.claims.sub, 'svc:services');

        const k = key();
        const updated = await control({ action: 'update', resource: object, project_id: prj, idempotency_key: k, params: { title: 'x' } });
        assert.strictEqual(updated.json().state, 'done');
        assert.strictEqual(media.seen.at(-1).body.idempotency_key, k, 'the caller\'s key reaches the authority');
        const deleted = await control({ action: 'delete', resource: object, project_id: prj, idempotency_key: key() });
        assert.strictEqual(deleted.json().state, 'done', 'a first-party delete not made for an agent is the authority\'s to gate');
        assert.strictEqual(media.seen.at(-1).body.action, 'delete');

        const row = await db.maybe('SELECT * FROM services_control_log WHERE idempotency_key = $1', [k]);
        assert.strictEqual(row.status, 'done');
        assert.strictEqual(row.actor_subject, 'svc:actor');
        assert.strictEqual(row.project_id, prj);
        assert.strictEqual(row.ovrn, object);
        assert.strictEqual(row.request.params, undefined, 'params are kept as a digest only');
        assert.match(row.request.params_sha256, /^[0-9a-f]{64}$/);
        assert.deepStrictEqual(row.response, updated.json());
    });

    await check('pending is 202; an authority\'s own refusal (confirmation_required) passes through unchanged', async () => {
        const started = await control({ action: 'start', resource: object, project_id: prj, idempotency_key: key() });
        assert.strictEqual(started.status, 202);
        assert.strictEqual(started.json().state, 'pending');
        const stopped = await control({ action: 'stop', resource: object, project_id: prj, idempotency_key: key() });
        assert.strictEqual(stopped.status, 200);
        assert.strictEqual(stopped.json().state, 'refused');
        assert.deepStrictEqual(stopped.json().confirmation_required, { confirmation_id: 'media-cnf-1', reason: 'the authority asks' });
        const retried = await control({ action: 'stop', resource: object, project_id: prj, idempotency_key: key(), confirmation_id: 'media-cnf-1' });
        assert.strictEqual(media.seen.at(-1).body.confirmation_id, 'media-cnf-1', 'an authority\'s confirmation id goes back to it');
        assert.strictEqual(retried.json().state, 'refused');
    });

    await check('idempotency: the same key answers the stored result without asking again; another body or caller is 409', async () => {
        const k = key();
        const body = { action: 'update', resource: object, project_id: prj, idempotency_key: k, params: { b: 2, a: 1 } };
        const first = await control(body);
        const calls = media.seen.length;
        const again = await control({ ...body, params: { a: 1, b: 2 } });
        assert.strictEqual(again.status, 200);
        assert.deepStrictEqual(again.json(), first.json(), 'the stored answer, byte for byte');
        assert.strictEqual(media.seen.length, calls, 'the authority is not asked twice');
        const other = await control({ ...body, params: { a: 2 } });
        assert.strictEqual(other.status, 409);
        assert.strictEqual(other.json().code, 'control.idempotency_conflict');
        const stranger = await control(body, `Bearer ${token(['services.resource.control'], { sub: 'svc:zone' })}`);
        assert.strictEqual(stranger.status, 409, 'another caller never reads this caller\'s answer');
        assert.strictEqual(await db.value('SELECT count(*)::int FROM services_control_log WHERE idempotency_key = $1', [k]), 1);
        // A claim still running is not run twice.
        const running = `run-${crypto.randomBytes(8).toString('hex')}`;
        await db.query(`INSERT INTO services_control_log (id, action, actor_subject, project_id, idempotency_key, request, status, at)
            VALUES ($1, 'update', 'svc:actor', $2, $3, $4::jsonb, 'pending', now())`,
        [`ctl_${ids.ulid()}`, prj, running, JSON.stringify({ digest: require('../server/domain/control').digestOf({ action: 'update', resource: object, project_id: prj }) })]);
        const busy = await control({ action: 'update', resource: object, project_id: prj, idempotency_key: running });
        assert.strictEqual(busy.status, 409);
        assert.strictEqual(busy.json().code, 'control.in_progress');
    });

    await check('an authority with no control endpoint answers failed resources.authority_unsupported', async () => {
        const before = media.seen.length;
        const queue = resources.format({ service: 'events', project_id: prj, type: 'queue', id: `evq_${ids.ulid()}` });
        const none = await control({ action: 'delete', resource: queue, project_id: prj, idempotency_key: key() });
        assert.strictEqual(none.status, 200);
        valid(none.json());
        assert.strictEqual(none.json().state, 'failed');
        assert.strictEqual(none.json().problem.code, 'resources.authority_unsupported');
        const watch = resources.format({ service: 'watch', project_id: prj, type: 'watch', id: `wch_${ids.ulid()}` });
        const notFound = await control({ action: 'update', resource: watch, project_id: prj, idempotency_key: key() });
        assert.strictEqual(notFound.json().state, 'failed', 'a 404 from the control path is no control endpoint');
        assert.strictEqual(notFound.json().problem.code, 'resources.authority_unsupported');
        const own = await control({ action: 'update', resource: `ovrn:services:${prj}:release/${ids.newId('release')}`, project_id: prj, idempotency_key: key() });
        assert.strictEqual(own.json().problem.code, 'resources.authority_unsupported', 'Services\' own resources have no control endpoint yet');
        assert.strictEqual(media.seen.length, before);
        const unknown = await control({ action: 'create', resource_kind: 'nowhere.thing', project_id: prj, idempotency_key: key() });
        assert.strictEqual(unknown.status, 400);
        assert.strictEqual(unknown.json().code, 'resources.unknown_service');
    });

    await check('an answer for a resource of another project is failed resources.authority_bad_response', async () => {
        const r = await control({ action: 'rotate', resource: object, project_id: prj, idempotency_key: key() });
        valid(r.json());
        assert.strictEqual(r.json().state, 'failed');
        assert.strictEqual(r.json().problem.code, 'resources.authority_bad_response');
    });

    await check('a person controls only a project they own or administer, and only for themself', async () => {
        const owner = t.network.addUser('ctl-owner');
        const dev = t.network.addUser('ctl-dev');
        const outsider = t.network.addUser('ctl-outsider');
        const project = await t.project(owner, 'Control project');
        t.network.state.members.get(project).set(dev.subject, 'developer');
        const res = resources.format({ service: 'media', project_id: project, type: 'object', id: ids.newId('media') });
        const as = (u) => `Bearer ${t.network.userToken(u)}`;
        const body = () => ({ action: 'update', resource: res, project_id: project, idempotency_key: key() });
        const ok = await control(body(), as(owner));
        assert.strictEqual(ok.status, 200, ok.text);
        assert.strictEqual(ok.json().state, 'done');
        assert.deepStrictEqual(media.seen.at(-1).body.on_behalf_of, { type: 'user', id: owner.subject }, 'the authority checks the person\'s grant');
        assert.strictEqual((await control(body(), as(dev))).status, 403);
        assert.strictEqual((await control(body(), as(outsider))).status, 404);
        const forOther = await control({ ...body(), on_behalf_of: { type: 'user', id: dev.subject } }, as(owner));
        assert.strictEqual(forOther.status, 403);
        const row = await db.maybe('SELECT actor_subject FROM services_control_log WHERE project_id = $1', [project]);
        assert.strictEqual(row.actor_subject, `user:${owner.subject}`);
    });

    await check('the console: an admin suspends what they own from the resources page; delete asks first; a viewer sees no actions', async () => {
        const owner = t.network.addUser('console-owner');
        const viewer = t.network.addUser('console-viewer');
        const project = await t.project(owner, 'Console project');
        t.network.state.members.get(project).set(viewer.subject, 'viewer');
        const mine = resources.format({ service: 'media', project_id: project, type: 'object', id: ids.newId('media') });
        const now = new Date().toISOString();
        media.list([{ id: mine.split('/').pop(), kind: 'media.object', service: 'media', project_id: project, owner: { type: 'user', id: owner.subject },
            name: 'clip.mp4', state: 'active', created_at: now, updated_at: now, ovrn: mine }]);
        const page = await t.get(`/projects/${project}/resources`, { as: owner });
        assert.strictEqual(page.status, 200);
        assert.ok(page.text.includes('<th>Actions</th>') || page.text.includes('Actions'), 'an Actions column');
        assert.ok(page.text.includes('value="delete"') && !page.text.includes('value="suspend"'), 'a media object takes delete only');
        const seenBefore = media.seen.length;
        const suspended = await t.get(`/projects/${project}/resources/control`, { as: owner, form: { resource: mine, action: 'suspend' } });
        assert.strictEqual(suspended.status, 303, suspended.text.slice(0, 300));
        assert.match(suspended.headers.get('location'), /done=Suspended/);
        const sent = media.seen.at(-1).body;
        assert.deepStrictEqual([sent.action, sent.resource, sent.project_id], ['suspend', mine, project]);
        assert.deepStrictEqual(sent.on_behalf_of, { type: 'user', id: owner.subject });
        const ask = await t.get(`/projects/${project}/resources/control`, { as: owner, form: { resource: mine, action: 'delete' } });
        assert.strictEqual(ask.status, 200);
        assert.ok(ask.text.includes('Delete this resource?'));
        assert.strictEqual(media.seen.length, seenBefore + 1, 'asking to delete sends nothing');
        const deleted = await t.get(`/projects/${project}/resources/control`, { as: owner, form: { resource: mine, action: 'delete', confirm: 'yes' } });
        assert.strictEqual(deleted.status, 303);
        assert.strictEqual(media.seen.at(-1).body.action, 'delete');
        const theirs = await t.get(`/projects/${project}/resources`, { as: viewer });
        assert.ok(!theirs.text.includes('value="delete"'), 'a viewer gets no controls');
        assert.strictEqual((await t.get(`/projects/${project}/resources/control`, { as: viewer, form: { resource: mine, action: 'suspend' } })).status, 403);
        media.list([]);
    });

    await check('the console offers what each kind takes; a project admin acts on what its apps made where the service allows it', async () => {
        const owner = t.network.addUser('kinds-owner');
        const project = await t.project(owner, 'Kinds project');
        const now = new Date().toISOString();
        const row = (kind, state, extra = {}) => {
            const [svc, type] = kind.split('.');
            const id = ids.newId(svc === 'media' ? 'media' : 'task');
            return { id, kind, service: 'media', project_id: project, name: `${kind} ${state}`, state, created_at: now, updated_at: now,
                ovrn: resources.format({ service: 'media', project_id: project, type, id }), ...extra };
        };
        const appMade = row('media.object', 'ready');
        const gone = row('media.object', 'deleted', { owner: { type: 'user', id: owner.subject } });
        media.list([appMade, gone]);
        const page = (await t.get(`/projects/${project}/resources`, { as: owner })).text;
        const cell = (x) => page.slice(page.indexOf(x.ovrn), page.indexOf('</tr>', page.indexOf(x.ovrn)));
        assert.ok(cell(appMade).includes('value="delete"'), 'an admin may delete what the project\'s app stored');
        assert.ok(!cell(gone).includes('<button'), 'a deleted object offers nothing');
        media.list([]);
    });

    await check('one audit row per accepted request (a replay too); neither table holds params or a token', async () => {
        const before = (await audits()).length;
        const k = key();
        const body = { action: 'update', resource: object, project_id: prj, idempotency_key: k, params: { secret_note: 'do-not-store-me' } };
        await control(body);
        await control(body);
        const rows = (await audits()).slice(before);
        assert.strictEqual(rows.length, 2);
        assert.deepStrictEqual(rows.map((r) => [r.actor, r.action, r.target, r.project_id]), [['svc:actor', 'resource.control', object, prj], ['svc:actor', 'resource.control', object, prj]]);
        assert.strictEqual(rows[0].detail.state, 'done');
        assert.strictEqual(rows[0].detail.replayed, undefined);
        assert.strictEqual(rows[1].detail.replayed, true);
        assert.strictEqual(rows[0].detail.control_id, rows[1].detail.control_id);
        const dump = await t.dbDump();
        assert.ok(!dump.includes('do-not-store-me'), 'params are never stored');
        assert.ok(!dump.includes(svc.slice(7)), 'the caller\'s token is never stored');
        assert.strictEqual(await db.value('SELECT count(*)::int FROM services_control_log WHERE response IS NULL AND idempotency_key LIKE $1', ['ctl-%']), 0, 'every claim was answered');
    });

    await t.close();
    await media.close();
    done();
})();
