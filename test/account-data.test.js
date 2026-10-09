'use strict';
/**
 * ADR-033: Services' part of an account export and of an account deletion, through the signed loopback route
 * POST /internal/events with a stand-in Network. A person's playground runs go; the manifests and releases they made
 * stay with their project without their id (created_by becomes 'deleted', the publisher NULL); the append-only release
 * log and staff trust tiers stay attributed; a redelivery erases nothing twice; a bad signature and a forwarded
 * request are refused.
 */
const assert = require('assert');
const http = require('http');
const { ids } = require('openvibe-contracts');
const { createNetworkSender } = require('openvibe-sdk/account-data');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { boot, check, done } = require('./helpers/boot');

const SECRET = `whsec_${'fixture'.repeat(6)}`;

async function startNetworkStub() {
    const calls = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/oauth/token') return json(200, { access_token: 'tok_services', token_type: 'Bearer', expires_in: 300 });
            calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') });
            return json(201, {});
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

(async () => {
    const stub = await startNetworkStub();
    const t = await boot({ env: { SERVICES_EVENTS_SECRET: SECRET }, accountSend: createNetworkSender({ networkInternalUrl: stub.url, clientId: 'services', clientSecret: 'services-secret' }) });
    const db = t.ctx.store.db;
    const me = ids.newId('user');
    const other = ids.newId('user');
    const count = async (sql, args) => Number(await db.value(sql, args));
    const deliver = async (event, { secret = SECRET, headers = {} } = {}) => {
        const body = JSON.stringify({ event, seq: 1 });
        const res = await fetch(`${t.base}/internal/events`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(body, secret), ...headers } });
        return { status: res.status, json: await res.json().catch(() => null) };
    };
    const ev = (id, type, payload) => ({ event_id: id, event_type: type, source: 'network', version: 1, timestamp: new Date().toISOString(), payload });
    const at = new Date().toISOString();
    const prj = ids.newId('project');
    const app = ids.newId('app');

    try {
        await check('the person\'s rows: a manifest, a release they published, a playground run, a log entry, a trust tier', async () => {
            await db.exec(`INSERT INTO manifests (id, kind, app_id, project_id, subject_id, version, body, contracts_version, created_by, created_at)
                VALUES ('mfs_1', 'app', $1, $2, $1, '1.0.0', '{"name":"My app"}', '0.119.0', $3, $4)`, [app, prj, `user:${me}`, at]);
            await db.exec(`INSERT INTO releases (id, app_id, project_id, environment, kind, subject_id, name, version, manifest_id, status, created_by, created_at, published_by, published_at)
                VALUES ('rel_1', $1, $2, 'production', 'app', $1, 'My app', '1.0.0', 'mfs_1', 'published', $3, $4, $3, $4)`, [app, prj, `user:${me}`, at]);
            await db.exec(`INSERT INTO release_log (release_id, action, actor, at) VALUES ('rel_1', 'release.published', $1, $2)`, [`user:${me}`, at]);
            await db.exec(`INSERT INTO trust (app_id, tier, note, set_by, set_at) VALUES ($1, 'reviewed', '', $2, $3)`, [app, `user:${me}`, at]);
            for (const [id, who] of [['run_1', me], ['run_2', other]]) {
                await db.exec(`INSERT INTO playground_runs (id, at, actor, project_id, app_id, kind, capability, credential, outcome, stage)
                    VALUES ($1, $2, $3, $4, $5, 'events', 'events.event.publish', 'access_token', 'ok', 'done')`, [id, at, `user:${who}`, prj, app]);
            }
        });

        await check('the export carries what they made and ran, and nobody else\'s', async () => {
            const r = await deliver(ev('evt_01JZ0000000000000000000E01', 'network.account.export_requested', { export_id: 'exp_01JZ0000000000000000000EX1', subject: me }));
            assert.deepStrictEqual([r.status, r.json && r.json.outcome], [200, 'exported'], JSON.stringify(r.json));
            const part = stub.calls.find((c) => c.url === '/internal/account-exports/exp_01JZ0000000000000000000EX1/parts');
            assert.strictEqual(part.auth, 'Bearer tok_services');
            assert.deepStrictEqual(part.body.files.map((f) => f.name).sort(), ['manifests.json', 'playground-runs.json', 'releases.json']);
            assert.strictEqual(part.body.files.find((f) => f.name === 'playground-runs.json').content.length, 1);
            assert.ok(!JSON.stringify(part.body).includes(other));
        });

        await check('the deletion removes their runs, leaves the project\'s manifest and release authorless, keeps the audit trail; once', async () => {
            const event = ev('evt_01JZ0000000000000000000D01', 'network.account.deleted', { deletion_id: 'del_01JZ0000000000000000000DE1', subject: me });
            const r = await deliver(event);
            assert.deepStrictEqual([r.status, r.json && r.json.outcome], [200, 'erased'], JSON.stringify(r.json));
            assert.strictEqual(await count('SELECT count(*) FROM playground_runs WHERE actor = $1', [`user:${me}`]), 0);
            assert.strictEqual(await count('SELECT count(*) FROM playground_runs WHERE actor = $1', [`user:${other}`]), 1);
            assert.strictEqual(await db.value("SELECT created_by FROM manifests WHERE id = 'mfs_1'"), 'deleted');
            const rel = await db.maybe("SELECT created_by, published_by, status FROM releases WHERE id = 'rel_1'");
            assert.deepStrictEqual([rel.created_by, rel.published_by, rel.status], ['deleted', null, 'published'], 'the release stays published');
            assert.strictEqual(await count('SELECT count(*) FROM release_log WHERE actor = $1', [`user:${me}`]), 1, 'the append-only log stays');
            assert.strictEqual(await count('SELECT count(*) FROM trust WHERE set_by = $1', [`user:${me}`]), 1, 'the staff tier stays attributed');
            const conf = stub.calls.filter((c) => c.url === '/internal/account-deletions/del_01JZ0000000000000000000DE1/confirmations');
            assert.strictEqual(conf.length, 1);
            assert.strictEqual(conf[0].body.erased.playground_runs, 1);
            assert.deepStrictEqual([conf[0].body.retained.release_log, conf[0].body.retained.trust], [1, 1]);
            assert.ok(conf[0].body.retained.tombstones >= 3);
            assert.strictEqual((await deliver(event)).json.outcome, 'unchanged');
            assert.strictEqual(stub.calls.filter((c) => c.url.includes('/confirmations')).length, 1);
        });

        await check('the route refuses a bad signature and a request that came through a proxy', async () => {
            const event = ev('evt_01JZ0000000000000000000E02', 'network.account.export_requested', { export_id: 'exp_01JZ0000000000000000000EX2', subject: me });
            assert.strictEqual((await deliver(event, { secret: `whsec_${'mismatch'.repeat(5)}` })).status, 401);
            assert.strictEqual((await deliver(event, { headers: { 'X-Forwarded-For': '203.0.113.9' } })).status, 403);
        });
    } finally {
        await t.close();
        await stub.close();
    }
    done();
})();
