'use strict';
// ADR-048 amendment 2026-10-15: a person controls their own resources outside any project (a robot here) through
// Services. A common.owned-resource-control-request@1 goes to the authority as Services, with the authority's own
// capability, only for its owner (their user token, or a first-party service acting for them; never an agent yet);
// the audit row names no project; "Your resources" offers the actions and asks before destructive ones.
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const { serviceAuth, ids, resources } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

/** A Bot authority: its index answers `listed`; its control checks the token and the owner it holds. */
async function startBot() {
    const seen = [];
    let network = null;
    let listed = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
            if (req.method === 'GET' && req.url.startsWith('/api/v1/resources')) return send(200, { resources: listed, next_cursor: null });
            if (req.url !== '/api/v1/resources/control' || req.method !== 'POST') return send(404, { type: 'about:blank', title: 'Not found', status: 404, code: 'route.not_found' });
            const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
            const v = serviceAuth.verifyServiceToken(token, { publicKey: network.publicPem, issuer: network.url, audience: 'openvibe.bot' });
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            seen.push({ body, claims: v.ok ? v.claims : null });
            if (!v.ok || !(v.claims.cap || []).includes('bot.resource.control')) return send(403, { type: 'about:blank', title: 'Forbidden', status: 403, code: 'capability.denied' });
            const at = new Date().toISOString();
            const row = listed.find((x) => x.id === body.owned.id);
            if (!row || !row.owner || row.owner.id !== body.owner.id) {
                return send(200, { action: body.action, state: 'refused', problem: { type: 'about:blank', title: 'resources.unknown_resource', status: 404, code: 'resources.unknown_resource', detail: 'no robot of this person' }, at });
            }
            if (row.name === 'Talks back') return send(200, { action: body.action, resource: resources.format({ service: 'bot', project_id: ids.newId('project'), type: 'robot', id: row.id }), state: 'done', at });
            return send(200, { action: body.action, state: 'done', result: { estop: body.action === 'stop', changed: true }, at });
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
    const bot = await startBot();
    const t = await boot({ authorities: registryOf([authority('bot', bot.url, 'bot.resource.control')]) });
    bot.bind(t.network);
    const db = t.ctx.store.db;
    const owner = t.network.addUser('ona');
    const other = t.network.addUser('oto');
    const ROBOT = ids.newId('robot');
    const LOUD = ids.newId('robot');
    const at = new Date().toISOString();
    bot.list([
        { id: ROBOT, kind: 'bot.robot', service: 'bot', name: 'Ona bot', state: 'ready', created_at: at, owner: { type: 'user', id: owner.subject } },
        { id: LOUD, kind: 'bot.robot', service: 'bot', name: 'Talks back', state: 'ready', created_at: at, owner: { type: 'user', id: owner.subject } },
    ]);
    const key = () => `ctl-${crypto.randomBytes(8).toString('hex')}`;
    const svcToken = (cap) => {
        const now = Math.floor(Date.now() / 1000);
        return serviceAuth.signServiceToken({ iss: t.network.url, sub: 'svc:actor', actor_type: 'service', aud: ['openvibe.services'], cap, iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(8).toString('hex')}` }, t.network.privatePem);
    };
    const asUser = (u) => `Bearer ${t.network.userToken(u)}`;
    const asService = `Bearer ${svcToken(['services.resource.control'])}`;
    const control = (body, authorization) => t.get('/api/v1/resources/control', { json: body, headers: { authorization } });
    const req = (over = {}) => ({ action: 'stop', owned: { kind: 'bot.robot', id: ROBOT }, owner: { type: 'user', id: owner.subject }, idempotency_key: key(), ...over });

    await check('the owner\'s own token: forwarded to Bot as Services with bot.resource.control; audited with no project', async () => {
        const r = await control(req(), asUser(owner));
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(resources.checkControlResult(r.json()).valid);
        assert.deepStrictEqual([r.json().state, r.json().result], ['done', { estop: true, changed: true }]);
        const last = bot.seen.at(-1);
        assert.deepStrictEqual([last.body.owned, last.body.owner, last.body.on_behalf_of], [{ kind: 'bot.robot', id: ROBOT }, { type: 'user', id: owner.subject }, { type: 'user', id: owner.subject }]);
        assert.strictEqual(last.body.project_id, undefined);
        assert.ok(last.claims && last.claims.cap.includes('bot.resource.control'), 'Services\' token for Bot holds bot.resource.control');
        const audit = await db.maybe("SELECT * FROM services_audit WHERE target = $1 ORDER BY id DESC LIMIT 1", [`bot.robot/${ROBOT}`]);
        assert.ok(audit && audit.project_id === null && audit.actor === `user:${owner.subject}` && audit.detail.state === 'done', JSON.stringify(audit));
    });

    await check('someone else, an agent, or a service that names nobody: refused before anything is forwarded', async () => {
        const before = bot.seen.length;
        let r = await control(req(), asUser(other));
        assert.deepStrictEqual([r.status, r.json().code], [403, 'capability.denied'], 'another person cannot name the owner');
        r = await control(req({ on_behalf_of: { type: 'agent', id: ids.newId('agent') } }), asService);
        assert.deepStrictEqual([r.status, r.json().code], [403, 'control.person_only'], 'agents are not offered person-owned resources yet');
        r = await control(req(), asService);
        assert.deepStrictEqual([r.status, r.json().code], [403, 'capability.denied'], 'a service must say whose request it is');
        assert.strictEqual(bot.seen.length, before, 'nothing reached Bot');
        r = await control(req({ on_behalf_of: { type: 'user', id: owner.subject } }), asService);
        assert.deepStrictEqual([r.status, r.json().state], [200, 'done'], 'a first-party service acting for the owner');
    });

    await check('an authority that names a resource for a person-owned one is a bad answer', async () => {
        const r = await control(req({ owned: { kind: 'bot.robot', id: LOUD } }), asUser(owner));
        assert.deepStrictEqual([r.json().state, r.json().problem.code], ['failed', 'resources.authority_bad_response']);
    });

    await check('Your resources offers the owner\'s actions; Stop goes through; a stranger\'s attempt is refused by the authority', async () => {
        let r = await t.get('/projects/mine', { as: owner });
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        assert.ok(r.text.includes('action="/projects/mine/resources/control"') && r.text.includes(`value="${ROBOT}"`) && r.text.includes('>Stop</button>'), 'a Stop button for the robot');
        r = await t.get('/projects/mine/resources/control', { as: owner, form: { kind: 'bot.robot', id: ROBOT, action: 'stop' } });
        assert.strictEqual(r.status, 303, r.text.slice(0, 300));
        assert.match(r.headers.get('location'), /^\/projects\/mine\?done=Stopped/);
        r = await t.get('/projects/mine/resources/control', { as: other, form: { kind: 'bot.robot', id: ROBOT, action: 'stop' } });
        assert.ok(r.text.includes('The service did not do it') && r.text.includes('resources.unknown_resource'), 'Bot checks the owner it holds');
        r = await t.get('/projects/mine/resources/control', { as: owner, form: { kind: 'community.paste', id: 'my-paste', action: 'delete' } });
        assert.ok(r.status === 200 && r.text.includes('Delete this?') && r.text.includes('name="confirm" value="yes"'), 'delete asks first');
        r = await t.get('/projects/mine/resources/control', { as: owner, form: { kind: 'media.object', id: 'x', action: 'delete' } });
        assert.strictEqual(r.status, 422, 'only the kinds a person owns');
    });

    await done(t);
    await bot.close();
})().catch((e) => { console.error(e); process.exit(1); });
