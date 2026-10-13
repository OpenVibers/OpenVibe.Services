'use strict';
// The sensitive-action gate of POST /api/v1/resources/control (ADR-048, roadmap WS-Z2, plan T13 step 10): a request an
// agent makes that deletes, spends money or publishes is refused with confirmation_required until the agent's owner
// approves it through Network's confirmations (OpenVibe.Network server/developer/confirmations.js; the Network mock
// serves its /internal/confirmations create and consume). The retry carries the confirmation_id; Services spends the
// approval once, for exactly that request, and only then asks the authority. Network mints and decides every
// confirmation; Services never does.
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const { serviceAuth, ids, resources } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            seen.push(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ action: body.action, resource: body.resource, state: 'done', at: new Date().toISOString() }));
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const media = Object.freeze({ id: 'media', name: 'media', internalOrigin: origin, publicOrigin: null, audience: 'openvibe.media', capability: 'media.resource.read',
        control: 'media.resource.control', manifestVersion: '0.1.0', contractsRange: null, status: 'beta' });
    const t = await boot({ authorities: { list: () => [media], get: (id) => (id === 'media' ? media : null), ids: () => ['media'], size: () => 1 } });
    const db = t.ctx.store.db;

    const now = () => Math.floor(Date.now() / 1000);
    const svc = `Bearer ${serviceAuth.signServiceToken({ iss: t.network.url, sub: 'svc:actor', actor_type: 'service', aud: ['openvibe.services'], cap: ['services.resource.control'], iat: now(), exp: now() + 600, jti: `tok_${crypto.randomBytes(8).toString('hex')}` }, t.network.privatePem)}`;
    const control = (body, authorization = svc) => t.get('/api/v1/resources/control', { json: body, headers: { authorization } });
    const key = () => `ctl-${crypto.randomBytes(8).toString('hex')}`;
    const valid = (r) => { const c = resources.checkControlResult(r); assert.ok(c.valid, JSON.stringify(c.errors)); };

    const owner = t.network.addUser('agent-owner');
    const agent = t.network.addAgent(owner.subject);
    const forAgent = { type: 'agent', id: agent };
    const prj = ids.newId('project');
    const object = () => resources.format({ service: 'media', project_id: prj, type: 'object', id: ids.newId('media') });
    const cnf = (id) => t.network.state.confirmations.get(id);

    const target = object();
    const k = key();
    const del = { action: 'delete', resource: target, project_id: prj, idempotency_key: k, on_behalf_of: forAgent };
    let confirmationId = null;

    await check('an agent\'s delete is refused with confirmation_required; the authority is not asked', async () => {
        const r = await control(del);
        assert.strictEqual(r.status, 200, r.text);
        valid(r.json());
        assert.strictEqual(r.json().state, 'refused');
        confirmationId = r.json().confirmation_required.confirmation_id;
        assert.match(confirmationId, /^cnf_[0-9A-HJKMNP-TV-Z]{26}$/, 'Network minted the id');
        assert.match(r.json().confirmation_required.reason, /deleting/);
        assert.strictEqual(seen.length, 0);
        const c = cnf(confirmationId);
        assert.strictEqual(c.state, 'pending');
        assert.strictEqual(c.agent_id, agent);
        assert.strictEqual(c.owner, owner.subject, 'Network asks the agent\'s owner');
        assert.strictEqual(c.capability, 'services.resource.control');
        assert.strictEqual(c.audience, 'openvibe.services');
        assert.match(c.request_digest, /^[0-9a-f]{64}$/);
        assert.strictEqual(c.details.resource, target);
        const row = await db.maybe('SELECT status FROM services_control_log WHERE idempotency_key = $1', [k]);
        assert.strictEqual(row.status, 'refused');
    });

    await check('a retry before the owner decides stays refused and keeps the confirmation', async () => {
        const r = await control({ ...del, confirmation_id: confirmationId });
        valid(r.json());
        assert.strictEqual(r.json().state, 'refused');
        assert.strictEqual(r.json().problem.code, 'confirmation.not_pending');
        assert.strictEqual(r.json().confirmation_required.confirmation_id, confirmationId);
        assert.strictEqual(seen.length, 0);
    });

    await check('the owner approves through Network\'s confirmations; the retry with confirmation_id is done, once', async () => {
        t.network.decideConfirmation(confirmationId, 'approved');
        const r = await control({ ...del, confirmation_id: confirmationId });
        assert.strictEqual(r.status, 200, r.text);
        valid(r.json());
        assert.strictEqual(r.json().state, 'done');
        assert.strictEqual(seen.length, 1);
        assert.strictEqual(seen[0].action, 'delete');
        assert.strictEqual(seen[0].confirmation_id, undefined, 'Services\' confirmation is spent here, never sent on');
        assert.deepStrictEqual(seen[0].on_behalf_of, forAgent);
        assert.ok(cnf(confirmationId).used_at, 'the approval was spent');
        const row = await db.maybe('SELECT status, response FROM services_control_log WHERE idempotency_key = $1', [k]);
        assert.strictEqual(row.status, 'done');
        const replay = await control({ ...del, confirmation_id: confirmationId });
        assert.strictEqual(replay.json().state, 'done');
        assert.strictEqual(seen.length, 1, 'a replay is answered from the log');
    });

    await check('an approval is spent once and only for its own request', async () => {
        const reused = await control({ ...del, idempotency_key: key(), confirmation_id: confirmationId });
        assert.strictEqual(reused.json().state, 'refused');
        assert.strictEqual(reused.json().problem.code, 'confirmation.used');
        const first = await control({ action: 'delete', resource: object(), project_id: prj, idempotency_key: key(), on_behalf_of: forAgent });
        const id = first.json().confirmation_required.confirmation_id;
        t.network.decideConfirmation(id, 'approved');
        const other = await control({ action: 'delete', resource: object(), project_id: prj, idempotency_key: key(), on_behalf_of: forAgent, confirmation_id: id });
        assert.strictEqual(other.json().state, 'refused');
        assert.strictEqual(other.json().problem.code, 'confirmation.mismatch', 'the approval is for another resource');
        assert.strictEqual(seen.length, 1);
    });

    await check('a denied confirmation never reaches the authority', async () => {
        const body = { action: 'delete', resource: object(), project_id: prj, idempotency_key: key(), on_behalf_of: forAgent };
        const id = (await control(body)).json().confirmation_required.confirmation_id;
        t.network.decideConfirmation(id, 'denied');
        const r = await control({ ...body, confirmation_id: id });
        assert.strictEqual(r.json().state, 'refused');
        assert.match(r.json().problem.detail, /denied/);
        assert.strictEqual(seen.length, 1);
    });

    await check('money and publishing are gated; a dry run, a plain update and a person\'s own request are not', async () => {
        for (const params of [{ amount_cents: 500 }, { budget: 10 }, { visibility: 'public' }, { publish: true }]) {
            const r = await control({ action: 'update', resource: object(), project_id: prj, idempotency_key: key(), on_behalf_of: forAgent, params });
            assert.strictEqual(r.json().state, 'refused', JSON.stringify(params));
            assert.ok(r.json().confirmation_required, JSON.stringify(params));
        }
        assert.strictEqual(seen.length, 1);
        const dry = await control({ ...del, idempotency_key: key(), resource: object(), dry_run: true });
        assert.strictEqual(dry.json().state, 'done');
        const plain = await control({ action: 'update', resource: object(), project_id: prj, idempotency_key: key(), on_behalf_of: forAgent, params: { title: 'x' } });
        assert.strictEqual(plain.json().state, 'done');
        const p = await t.project(owner, 'Owner project');
        const mine = await control({ action: 'delete', resource: resources.format({ service: 'media', project_id: p, type: 'object', id: ids.newId('media') }), project_id: p, idempotency_key: key() },
            `Bearer ${t.network.userToken(owner)}`);
        assert.strictEqual(mine.json().state, 'done', 'the owner acting with their own token is the one who would confirm');
        assert.strictEqual(seen.length, 4);
    });

    await check('a standing rule approves at creation: the request proceeds at once and spends it', async () => {
        t.network.setStandingRule(agent, 'services.resource.control');
        const r = await control({ action: 'delete', resource: object(), project_id: prj, idempotency_key: key(), on_behalf_of: forAgent });
        assert.strictEqual(r.json().state, 'done');
        const latest = [...t.network.state.confirmations.values()].at(-1);
        assert.strictEqual(latest.state, 'approved');
        assert.ok(latest.used_at);
        t.network.state.standingRules.clear();
    });

    await check('Network unreachable: the sensitive request fails and nothing is applied', async () => {
        const before = seen.length;
        t.network.setDown(true);
        const r = await control({ action: 'delete', resource: object(), project_id: prj, idempotency_key: key(), on_behalf_of: forAgent });
        t.network.setDown(false);
        valid(r.json());
        assert.strictEqual(r.json().state, 'failed');
        assert.strictEqual(r.json().problem.code, 'confirmations.unavailable');
        assert.strictEqual(seen.length, before);
    });

    await check('every request left one control-log row per key and one audit row, naming the confirmation', async () => {
        const audit = await db.many('SELECT * FROM services_audit WHERE target = $1 ORDER BY id', [target]);
        assert.deepStrictEqual(audit.map((a) => a.detail.state), ['refused', 'refused', 'done', 'done', 'refused'], 'the first, the early retry, the approved retry, the replay, the reuse');
        assert.ok(audit.slice(0, 3).every((a) => a.detail.confirmation_id === confirmationId));
        assert.strictEqual(audit[3].detail.replayed, true);
        assert.strictEqual(await db.value('SELECT count(*)::int FROM services_control_log WHERE idempotency_key = $1', [k]), 1);
    });

    await t.close();
    await new Promise((r) => server.close(r));
    done();
})();
