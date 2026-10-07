'use strict';
/**
 * migrations/0001_initial.sql on a real (PGlite) PostgreSQL: the seven tables Services owns, the
 * idempotency key of services_control_log, the services_resources foreign key to the authority registry,
 * and the outbox table's shape.
 *
 *   node test/db.test.js
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { testDb } = require('./helpers/db');
const { check, done } = require('./helpers/app');

async function main() {
    const store = await testDb();
    const db = store.db;
    try {
        await check('every table of 0001_initial.sql exists', async () => {
            const rows = await db.many("SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename");
            const names = rows.map((r) => r.tablename);
            for (const t of ['services_authorities', 'services_resources', 'services_catalog_entries', 'services_recipes', 'services_recipe_runs', 'services_control_log', 'services_events_outbox']) {
                assert.ok(names.includes(t), `${t} exists (have ${names.join(', ')})`);
            }
        });

        await check('services_authorities takes the registry row and refuses a bad trust or status', async () => {
            await db.query(`INSERT INTO services_authorities (id, name, internal_origin, manifest_version) VALUES ('media', 'OpenVibe.Media', 'http://127.0.0.1:4100', '0.2.0')`);
            const row = await db.one('SELECT id, trust, status FROM services_authorities WHERE id = $1', ['media']);
            assert.deepStrictEqual(row, { id: 'media', trust: 'first-party', status: 'unknown' });
            await assert.rejects(() => db.query(`INSERT INTO services_authorities (id, name, internal_origin, manifest_version, trust) VALUES ('x', 'x', 'http://127.0.0.1:1', '0', 'friend')`));
        });

        await check('services_resources references the authority registry: no resource of no service', async () => {
            const project = ids.newId('project');
            const object = ids.newId('media');
            await assert.rejects(() => db.query(`INSERT INTO services_resources (ovrn, service, project_id, kind, resource_id, state)
                VALUES ($1, 'ghost', $2, 'ghost.thing', $3, 'active')`, [`ovrn:ghost:${project}:thing/${object}`, project, object]));
            await db.query(`INSERT INTO services_resources (ovrn, service, project_id, kind, resource_id, state)
                VALUES ($1, 'media', $2, 'media.object', $3, 'active')`, [`ovrn:media:${project}:object/${object}`, project, object]);
            assert.strictEqual(await db.value('SELECT count(*)::int FROM services_resources'), 1);
        });

        await check('services_control_log holds one row per idempotency key', async () => {
            const insert = (id, key) => db.query(`INSERT INTO services_control_log (id, action, actor_subject, idempotency_key, request, status)
                VALUES ($1, 'start', $2, $3, '{}'::jsonb, 'pending')`, [id, `user:${ids.newId('user')}`, key]);
            await insert(`ctl_${ids.ulid()}`, 'key-1');
            await assert.rejects(() => insert(`ctl_${ids.ulid()}`, 'key-1'));       // the same key, another row: refused
            await insert(`ctl_${ids.ulid()}`, 'key-2');
            assert.strictEqual(await db.value('SELECT count(*)::int FROM services_control_log'), 2);
        });

        await check('services_events_outbox is the openvibe-sdk outbox shape, ready for the first event', async () => {
            const cols = (await db.many("SELECT column_name FROM information_schema.columns WHERE table_name = 'services_events_outbox'")).map((r) => r.column_name);
            for (const c of ['id', 'event_id', 'envelope', 'traceparent', 'created_at', 'attempts', 'next_attempt_at', 'sent_at', 'seq', 'rejected_at', 'last_error']) {
                assert.ok(cols.includes(c), `outbox column ${c}`);
            }
            assert.strictEqual(await db.value('SELECT count(*)::int FROM services_events_outbox'), 0);
        });
    } finally {
        await store.close();
    }
    done();
}

main().catch((e) => { console.error(e); process.exit(1); });
