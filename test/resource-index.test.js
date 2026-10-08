'use strict';
// Services' own resources as an authority (ADR-048 section 3): server/registry/resource-index.js pages
// common.resource-summary@1 for the resources Services owns — its validated manifests (services.manifest, mfs_) and
// its releases (services.release, rel_) — and reads one by its computed ovrn. project/kind/cursor/limit are honoured;
// project is the tenancy boundary, so a resource of another project is never returned. Both kinds are nameable, so
// every summary carries an ovrn and the project it was created in. The merged index (GET /api/v1/resources, guarded
// by services.resource.read) reads them in process (server/registry/self-authority.js), and every page and read is
// validated against the released common.resource-list-result@1 / common.resource-summary@1.
const assert = require('assert');
const crypto = require('crypto');
const { validate, ids, serviceAuth } = require('openvibe-contracts');
const resourceIndex = require('../server/registry/resource-index');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const db = t.ctx.store.db;
    const at = '2026-10-01T00:00:00Z';

    // ── Fixtures: two projects, their manifests (user- and app-created) and releases in three states ──
    const prjA = ids.newId('project'); const prjB = ids.newId('project');
    const usrA = ids.newId('user');
    const appA = ids.newId('app'); const appB = ids.newId('app');
    const subjA = ids.newId('app'); const subjB = ids.newId('app');
    const mfsA1 = ids.newId('manifest'); const mfsA2 = ids.newId('manifest'); const mfsB = ids.newId('manifest');
    const relA1 = ids.newId('release'); const relA2 = ids.newId('release'); const relB = ids.newId('release');
    const usrB = ids.newId('user');

    const insertManifest = db.prepare('INSERT INTO manifests (id, kind, app_id, project_id, subject_id, version, body, contracts_version, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertRelease = db.prepare("INSERT INTO releases (id, app_id, project_id, environment, kind, subject_id, name, version, manifest_id, status, compatibility, notes, created_by, created_at) VALUES (?, ?, ?, 'sandbox', ?, ?, ?, ?, ?, ?, '{}', '', ?, ?)");
    const body = (subject, name, version) => JSON.stringify({ id: subject, name, version });
    await insertManifest.run(mfsA1, 'app', appA, prjA, subjA, '1.0.0', body(subjA, 'Notes app', '1.0.0'), '0.107.0', `user:${usrA}`, at);
    await insertManifest.run(mfsA2, 'app', appA, prjA, subjA, '1.1.0', body(subjA, 'Notes app', '1.1.0'), '0.107.0', `app:${appA}`, at);
    await insertManifest.run(mfsB, 'app', appB, prjB, subjB, '1.0.0', body(subjB, 'Other app', '1.0.0'), '0.107.0', `user:${usrB}`, at);
    await insertRelease.run(relA1, appA, prjA, 'app', subjA, 'Notes app', '1.0.0', mfsA1, 'published', `user:${usrA}`, at);
    await insertRelease.run(relA2, appA, prjA, 'app', subjA, 'Notes app', '1.1.0', mfsA2, 'draft', `app:${appA}`, at);
    await insertRelease.run(relB, appB, prjB, 'app', subjB, 'Other app', '1.0.0', mfsB, 'revoked', `user:${usrB}`, at);

    const expected = [
        { id: mfsA1, kind: resourceIndex.MANIFEST_KIND }, { id: mfsA2, kind: resourceIndex.MANIFEST_KIND }, { id: mfsB, kind: resourceIndex.MANIFEST_KIND },
        { id: relA1, kind: resourceIndex.RELEASE_KIND }, { id: relA2, kind: resourceIndex.RELEASE_KIND }, { id: relB, kind: resourceIndex.RELEASE_KIND },
    ].sort((x, y) => (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    const ovrnOfManifest = (project, id) => `ovrn:services:${project}:manifest/${id}`;
    const ovrnOfRelease = (project, id) => `ovrn:services:${project}:release/${id}`;

    // A first-party service token signed by the Network mock, holding the capabilities asked for.
    const token = (cap, { aud = 'openvibe.services', sub = 'svc:services' } = {}) => {
        const now = Math.floor(Date.now() / 1000);
        return serviceAuth.signServiceToken({ iss: t.network.url, sub, actor_type: 'service', aud: [aud], cap, iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(8).toString('hex')}` }, t.network.privatePem);
    };
    const get = (path, headers) => t.get(path, headers ? { headers } : {});
    const auth = { authorization: `Bearer ${token([resourceIndex.RESOURCE_READ])}` };

    const page = async (q = {}) => {
        const r = await resourceIndex.pageOf(db, q);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.ok(validate('common.resource-list-result@1', r.body).valid, JSON.stringify(validate('common.resource-list-result@1', r.body).errors));
        return r.body;
    };
    const idsOf = async (q) => (await page(q)).resources.map((r) => r.id);

    await check('a page is common.resource-list-result@1: only its fields, every summary valid and sorted', async () => {
        const y = await page();
        assert.deepStrictEqual(Object.keys(y).sort(), ['next_cursor', 'resources'], 'the page carries only the contract fields');
        y.resources.forEach((s) => assert.ok(validate('common.resource-summary@1', s).valid, `${s.id}: ${JSON.stringify(validate('common.resource-summary@1', s).errors)}`));
        assert.strictEqual(y.next_cursor, null, 'one page holds the whole index');
        assert.deepStrictEqual(y.resources.map((r) => [r.kind, r.id]), expected.map((r) => [r.kind, r.id]), 'both kinds, sorted by (kind, id)');
        assert.deepStrictEqual([...new Set(y.resources.map((r) => r.service))], ['services']);
        assert.deepStrictEqual([...new Set(y.resources.map((r) => r.project_id))].sort(), [prjA, prjB].sort(), 'every summary carries the project it was created in');
    });

    await check('every summary carries its computed ovrn, name, state and owner', async () => {
        const byId = new Map((await page()).resources.map((r) => [r.id, r]));
        assert.strictEqual(byId.get(mfsA1).ovrn, ovrnOfManifest(prjA, mfsA1));
        assert.strictEqual(byId.get(mfsB).ovrn, ovrnOfManifest(prjB, mfsB));
        assert.strictEqual(byId.get(relA1).ovrn, ovrnOfRelease(prjA, relA1));
        assert.strictEqual(byId.get(relB).ovrn, ovrnOfRelease(prjB, relB));
        assert.strictEqual(byId.get(mfsA1).name, 'Notes app', 'a manifest is named by its stored body');
        assert.strictEqual(byId.get(relA1).name, 'Notes app', "a release is named by the release row's own name");
        assert.deepStrictEqual(byId.get(mfsA1).owner, { type: 'user', id: usrA }, 'a user-created resource names its owner');
        assert.ok(!('owner' in byId.get(mfsA2)), 'an app-created resource has no person owner');
        assert.strictEqual(byId.get(mfsA1).state, 'valid', 'a stored manifest is a validated, immutable row');
        assert.strictEqual(byId.get(relA1).state, 'published', 'a release state is its status');
        assert.strictEqual(byId.get(relA2).state, 'draft');
        assert.strictEqual(byId.get(relB).state, 'revoked');
    });

    await check('project is the tenancy boundary: another project\'s rows are never returned', async () => {
        assert.deepStrictEqual((await idsOf({ project: prjA })).sort(), [mfsA1, mfsA2, relA1, relA2].sort());
        assert.deepStrictEqual((await idsOf({ project: prjB })).sort(), [mfsB, relB].sort());
        assert.deepStrictEqual(await idsOf({ project: ids.newId('project') }), [], 'an unknown project has no resources');
    });

    await check('kind narrows to one kind; an unknown kind is an empty page, not an error', async () => {
        assert.deepStrictEqual((await idsOf({ kind: 'services.manifest' })).sort(), [mfsA1, mfsA2, mfsB].sort());
        assert.deepStrictEqual((await idsOf({ kind: 'services.release' })).sort(), [relA1, relA2, relB].sort());
        assert.deepStrictEqual((await idsOf({ project: prjA, kind: 'services.release' })).sort(), [relA1, relA2].sort(), 'kind narrows within the project');
        assert.deepStrictEqual(await idsOf({ kind: 'services.unknown' }), []);
    });

    await check('an opaque cursor pages the whole set: no duplicates, none skipped, order preserved', async () => {
        const seen = [];
        let cursor = null;
        for (let pages = 0; ; pages++) {
            const y = await page({ limit: '2', ...(cursor ? { cursor } : {}) });
            seen.push(...y.resources.map((r) => r.id));
            if (y.next_cursor === null) break;
            cursor = y.next_cursor;
            if (pages > 50) assert.fail('the cursor chain never ended');
        }
        assert.deepStrictEqual(seen, expected.map((r) => r.id));
    });

    await check('one resource by its computed name; an unknown or non-matching OVRN is 404 resources.not_found', async () => {
        const listed = new Map((await page()).resources.map((r) => [r.id, r]));
        for (const [name, id] of [[ovrnOfManifest(prjA, mfsA1), mfsA1], [ovrnOfRelease(prjA, relA1), relA1]]) {
            const r = await resourceIndex.oneOf(db, name);
            assert.strictEqual(r.status, 200, name);
            assert.deepStrictEqual(r.body, listed.get(id), 'the same summary the list answers');
        }
        for (const name of [ovrnOfManifest(prjA, ids.newId('manifest')), ovrnOfRelease(prjA, relB), `ovrn:services:${prjA}:object/${mfsA1}`, ovrnOfRelease(prjA, mfsA1), 'nope']) {
            const r = await resourceIndex.oneOf(db, name);
            assert.deepStrictEqual([r.status, r.body.code], [404, 'resources.not_found'], name);
        }
    });

    await check('a query that cannot be honoured is 400 resources.bad_query', async () => {
        for (const q of [{ project: 'nope' }, { limit: '0' }, { limit: 'abc' }, { limit: '99999' }, { cursor: '***' }]) {
            const r = await resourceIndex.pageOf(db, q);
            assert.deepStrictEqual([r.status, r.body.code], [400, 'resources.bad_query'], JSON.stringify(q));
        }
    });

    // ── The merged index serves them, in process, behind services.resource.read ──
    await check('GET /api/v1/resources?service=services: Services\' own resources, guarded, never partial', async () => {
        assert.strictEqual((await get('/api/v1/resources?service=services')).status, 401, 'no token');
        assert.strictEqual((await get('/api/v1/resources?service=services', { authorization: `Bearer ${token(['services.release.read'])}` })).status, 403, 'a token without the capability');
        const y = await get('/api/v1/resources?service=services', auth);
        assert.strictEqual(y.status, 200, y.text.slice(0, 300));
        assert.deepStrictEqual(y.json().resources.map((r) => r.id).sort(), expected.map((r) => r.id).sort());
        assert.ok(!(y.json().partial || []).length, 'the in-process authority is never partial');
        const one = await get(`/api/v1/resources/${encodeURIComponent(ovrnOfRelease(prjA, relA1))}`, auth);
        assert.strictEqual(one.status, 200, one.text.slice(0, 300));
        assert.strictEqual(one.json().id, relA1);
        assert.strictEqual((await get(`/api/v1/resources/${encodeURIComponent(ovrnOfRelease(prjA, ids.newId('release')))}`, auth)).status, 404);
    });

    await t.close();
    done();
})();
