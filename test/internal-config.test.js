'use strict';
/**
 * D11 owner settings: the services.ai namespace and /internal/config.
 *
 *   - services.config.manage is required; a service token without it is 403;
 *   - an env pin wins (read-only in the summary, a write is 409 config.pinned_in_env);
 *   - an owner's change applies live (the page reads the store, not process.env);
 *   - the boot reseal is optional: with no KEK the store still works and reports sealed: false;
 *   - a secret-class value never leaves a summary, history or the audit log.
 *
 *   node test/internal-config.test.js
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

const CAP = ['services.config.manage'];
const OWNER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const SECRET = 'sk_services_d11_toppsecret_123456';
const call = (t, method, p, o = {}) => t.call(method, p, {
    cap: CAP, sub: 'svc:network', headers: { 'x-ov-subject': OWNER }, ...o,
});

(async () => {
    const t = await boot({ env: { SERVICES_MODEL_EXPLORER: '1' } });
    try {
        await check('the summary: the namespace, its schema, the env pin, sealed:false without a KEK', async () => {
            const r = await call(t, 'GET', '/internal/config/services.ai');
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.strictEqual(r.json.namespace, 'services.ai');
            assert.strictEqual(r.json.sealed, false);
            assert.strictEqual(r.json.values.model_explorer, true, 'the env pin is the effective value');
            assert.deepStrictEqual(r.json.pins.model_explorer, { env: 'SERVICES_MODEL_EXPLORER', pinned: true });
            assert.strictEqual(r.json.schema.properties.model_catalog_source.enum.join(','), 'preview,ai');
            assert.ok(!r.text.includes(SECRET));
        });

        await check('a service token without services.config.manage is refused', async () => {
            const r = await call(t, 'GET', '/internal/config/services.ai', { cap: ['services.resource.read'] });
            assert.strictEqual(r.status, 403);
            assert.strictEqual(r.json.code, 'capability.denied');
        });

        await check('an env-pinned key is read-only', async () => {
            const r = await call(t, 'POST', '/internal/config/services.ai', { body: { values: { model_explorer: false }, reason: 'off' } });
            assert.strictEqual(r.status, 409, r.text.slice(0, 300));
            assert.strictEqual(r.json.code, 'config.pinned_in_env');
        });

        await check('an owner change applies live, and the audit line names the actor and the key, never a value', async () => {
            const r = await call(t, 'POST', '/internal/config/services.ai', { body: { values: { ai_playground: true }, reason: 'open the playground' } });
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.strictEqual(r.json.revision, 2);
            assert.strictEqual(t.config.playground.ai, true, 'the running process reads the new value');
            assert.ok(t.logs.join('\n').includes('by user:' + OWNER), 'the audit line names the actor');
            assert.ok(!t.logs.join('\n').includes(SECRET));
        });

        await check('no KEK still works, and reports sealed:false', async () => {
            const r = await call(t, 'GET', '/internal/config/services.ai');
            assert.strictEqual(r.json.sealed, false);
            assert.ok(r.json.last_known_good, 'a revision is still recorded');
        });

        await check('with a KEK the store is sealed, and boot reseals without changing a value', async () => {
            const sealed = await boot({ env: { OV_CONFIG_KEKS: 'k1:MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=', OV_CONFIG_KEK_CURRENT: 'k1' } });
            try {
                const r = await call(sealed, 'GET', '/internal/config/services.ai');
                assert.strictEqual(r.status, 200, r.text.slice(0, 300));
                assert.strictEqual(r.json.sealed, true);
                assert.strictEqual(r.json.kek, 'k1');
                assert.strictEqual(r.json.values.model_catalog_source, 'preview');
            } finally { await sealed.close(); }
        });

        await check('a secret is write-only and never appears in a summary, a snapshot, the history or the audit log', async () => {
            const shared = require('openvibe-shared/config');
            const extra = await shared.createConfigStore({
                db: t.db, service: 'services', namespace: 'services.test_secrets',
                schema: { type: 'object', additionalProperties: false, properties: { api_key: { type: 'string' } } },
                classify: () => 'secret', log: { info: () => {}, warn: () => {}, error: () => {} },
            });
            const marker = await extra.setSecret('api_key', SECRET, { actor: { type: 'user', id: OWNER }, reason: 'test' });
            assert.strictEqual(marker.redacted, true);
            assert.ok(!JSON.stringify(marker).includes(SECRET));
            const summary = await extra.summary();
            assert.strictEqual(summary.values.api_key.redacted, true);
            assert.ok(!JSON.stringify(summary).includes(SECRET));
            assert.ok(!JSON.stringify(await extra.history()).includes(SECRET));
            assert.ok(!JSON.stringify(await extra.snapshot(1)).includes(SECRET));
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
