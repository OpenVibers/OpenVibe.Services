'use strict';
/**
 * A project's Resources page (ADR-048, plan T13): /projects/:project/resources renders the merged resource index
 * for that project, server-side and complete without JavaScript. Network decides who may see it (any member, or
 * staff) before any authority is asked; rows of another project never appear; the service and kind filters are a
 * GET form whose malformed values are refused, not ignored; an authority that could not be read is named with the
 * problem it gave; pages are walked with the index's own cursor; an authority's names are escaped.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const db = t.ctx.store.db;
    const owner = t.network.addUser('ona');
    const viewer = t.network.addUser('vee');
    const stranger = t.network.addUser('sam');
    const projectId = await t.project(owner, 'Indexed');
    const otherId = await t.project(stranger, 'Elsewhere');
    assert.strictEqual((await t.get(`/projects/${projectId}/members`, { as: owner, form: { username: 'vee', role: 'viewer' } })).status, 303);

    // Services' own resources (read in process by the index): releases and manifests in both projects.
    const at = '2026-10-01T00:00:00Z';
    const insertManifest = db.prepare('INSERT INTO manifests (id, kind, app_id, project_id, subject_id, version, body, contracts_version, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertRelease = db.prepare("INSERT INTO releases (id, app_id, project_id, environment, kind, subject_id, name, version, manifest_id, status, compatibility, notes, created_by, created_at) VALUES (?, ?, ?, 'sandbox', ?, ?, ?, ?, ?, ?, '{}', '', ?, ?)");
    const add = async (project, name, status, by, n = 1) => {
        const app = ids.newId('app'); const subject = ids.newId('app');
        const made = [];
        for (let i = 0; i < n; i++) {
            const mfs = ids.newId('manifest'); const rel = ids.newId('release');
            const version = `1.0.${i}`;
            await insertManifest.run(mfs, 'app', app, project, subject, version, JSON.stringify({ id: subject, name, version }), '0.107.0', by, at);
            await insertRelease.run(rel, app, project, 'app', subject, name, version, mfs, status, by, at);
            made.push({ mfs, rel });
        }
        return made;
    };
    const [mine] = await add(projectId, 'Notes <img src=x onerror=alert(1)>', 'published', `user:${owner.subject}`);
    const [theirs] = await add(otherId, 'Secret app', 'draft', `user:${stranger.subject}`);
    const page = `/projects/${projectId}/resources`;

    // Count what the index is asked, and let a check set the partial answer. (The test registry's own authorities
    // are not running, so the real answer already names them.)
    const realList = t.ctx.index.list;
    const asked = [];
    let partialAs = null;
    t.ctx.index.list = async (q) => { asked.push(q); const out = await realList(q); return partialAs ? { ...out, partial: partialAs } : out; };

    await check('the project page links its resources for every member', async () => {
        for (const who of [owner, viewer]) {
            const r = await t.get(`/projects/${projectId}`, { as: who });
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes(`<a href="/projects/${projectId}/resources">Resources</a>`), 'the Resources link');
        }
    });

    await check('the owner sees this project\'s resources, server-rendered, with their OVRNs, states and owner', async () => {
        const r = await t.get(page, { as: owner });
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        assert.match(r.text, /<h1>Resources <small>Indexed<\/small><\/h1>/);
        assert.ok(r.text.includes(`<code class="small">ovrn:services:${projectId}:release/${mine.rel}</code>`), 'the release by its OVRN');
        assert.ok(r.text.includes(`<code class="small">ovrn:services:${projectId}:manifest/${mine.mfs}</code>`), 'the manifest by its OVRN');
        assert.match(r.text, /<span class="badge ok">published<\/span>/);
        assert.match(r.text, /<td>you<\/td>/);
        assert.ok(r.text.includes(`<a href="${page}?kind=services.release"><code>services.release</code></a>`), 'a kind narrows the list');
        assert.ok(!r.text.includes(theirs.rel) && !r.text.includes(theirs.mfs) && !r.text.includes('Secret app'), 'nothing of another project');
        assert.ok(!r.text.includes('<img src=x'), 'an authority\'s name is escaped');
        assert.ok(r.text.includes('&lt;img src=x onerror=alert(1)&gt;'), 'and shown as text');
        assert.match(r.text, new RegExp(`<form method="get" action="${page}"`));
        assert.ok(!/src="\/js\//.test(r.text), 'no Services script on the page');
        assert.deepStrictEqual(asked.at(-1), { service: null, kind: null, cursor: null, project: projectId, limit: 50 });
    });

    await check('a viewer member sees them too; a stranger gets Network\'s answer and no authority is asked', async () => {
        const v = await t.get(page, { as: viewer });
        assert.strictEqual(v.status, 200);
        assert.ok(v.text.includes(mine.rel));
        assert.ok(!/<td>you<\/td>/.test(v.text), 'the owner column names the owner, not the viewer');
        const before = asked.length;
        const s = await t.get(page, { as: stranger });
        assert.strictEqual(s.status, 404, s.text.slice(0, 200));
        assert.ok(!s.text.includes(mine.rel));
        assert.strictEqual(asked.length, before, 'the index is not asked for a non-member');
        const anon = await t.get(page);
        assert.strictEqual(anon.status, 401);
    });

    await check('the filters reach the index as offered; a malformed or unknown one is refused, not ignored', async () => {
        let r = await t.get(`${page}?service=services&kind=services.manifest`, { as: owner });
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /<option value="services" selected>/);
        assert.ok(r.text.includes(mine.mfs) && !r.text.includes(`release/${mine.rel}`), 'only manifests');
        assert.deepStrictEqual(asked.at(-1), { service: 'services', kind: 'services.manifest', cursor: null, project: projectId, limit: 50 });
        assert.ok(r.text.includes(`<a href="${page}">Clear</a>`));
        r = await t.get(`${page}?kind=services.nothing`, { as: owner });
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /No resources match this filter\./);
        r = await t.get(`${page}?kind=${encodeURIComponent('<b>')}`, { as: owner });
        assert.strictEqual(r.status, 400);
        assert.match(r.text, /That filter was refused: kind must be &lt;service&gt;\.&lt;type&gt; \(<code>resources\.bad_query<\/code>\)/);
        r = await t.get(`${page}?service=nowhere`, { as: owner });
        assert.strictEqual(r.status, 400);
        assert.match(r.text, /<code>resources\.unknown_service<\/code>/);
        r = await t.get(`${page}?cursor=forged`, { as: owner });
        assert.strictEqual(r.status, 400);
        assert.match(r.text, /cursor must be one this index issued/);
    });

    await check('an authority that could not be read is named with its problem; the rest is served', async () => {
        partialAs = [{ service: 'media', code: 'resources.authority_timeout' }, { service: 'chat', code: 'resources.authority_unavailable' }];
        try {
            const r = await t.get(page, { as: owner });
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('Not on this page: <strong>media</strong> (<code>resources.authority_timeout</code>), <strong>chat</strong> (<code>resources.authority_unavailable</code>) could not be read just now.'), r.text.match(/Not on this page.{0,400}/s)[0]);
            assert.ok(r.text.includes(mine.rel), 'the rows that could be read are still there');
            partialAs = [];
            const whole = await t.get(page, { as: owner });
            assert.ok(!whole.text.includes('Not on this page'), 'a complete page says nothing of the kind');
        } finally { partialAs = null; }
    });

    await check('pages are walked with the index\'s cursor, never repeating or skipping a resource', async () => {
        const many = await add(projectId, 'Bulk', 'draft', `app:${ids.newId('app')}`, 30);
        const want = new Set([mine.rel, mine.mfs, ...many.flatMap((x) => [x.rel, x.mfs])]);
        const seen = [];
        let url = page;
        let pages = 0;
        while (url) {
            const r = await t.get(url, { as: owner });
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            pages++;
            for (const m of r.text.matchAll(/:(?:release|manifest)\/((?:rel|mfs)_[0-9A-Z]{26})<\/code>/g)) seen.push(m[1]);
            if (pages > 1) assert.ok(r.text.includes(`<a href="${page}">First page</a>`), 'a later page links back to the first');
            const next = r.text.match(/<a href="([^"]+)">Next page<\/a>/);
            url = next ? next[1].replace(/&amp;/g, '&') : null;
            assert.ok(pages < 5, 'the walk ends');
        }
        assert.strictEqual(pages, 2, '62 resources at 50 a page');
        assert.strictEqual(seen.length, want.size, 'each resource once');
        assert.deepStrictEqual(new Set(seen), want);
    });

    await check('your resources: the person\'s own, in no project, asked of every authority by owner and kept to them', async () => {
        const { createResourceIndexService } = require('../server/resources');
        const bob = t.network.addUser('bob');
        const at = '2026-10-01T00:00:00.000Z';
        const rob = (id, owner, extra = {}) => ({ id, kind: 'bot.robot', service: 'bot', name: `Robot ${id.slice(-2)}`, state: 'ready', created_at: at, ...(owner ? { owner: { type: 'user', id: owner } } : {}), ...extra });
        const R1 = 'rob_01JAB2C3D4E5F6G7H8J9K0MN01', R2 = 'rob_01JAB2C3D4E5F6G7H8J9K0MN02', R3 = 'rob_01JAB2C3D4E5F6G7H8J9K0MN03', R4 = 'rob_01JAB2C3D4E5F6G7H8J9K0MN04';
        const seen = [];
        // An authority that has not added the owner filter: it answers everyone's, including a projected row of the owner.
        const careless = {
            authority: Object.freeze({ id: 'bot', name: 'OpenVibe.Bot', internalOrigin: 'http://bot.fake', publicOrigin: 'https://openvibe.bot', audience: 'openvibe.bot', capability: 'bot.resource.read', status: 'in-process' }),
            origin: 'http://bot.fake',
            async fetchAs(url) {
                seen.push(new URL(url));
                const body = { resources: [rob(R1, owner.subject), rob(R2, bob.subject), rob(R3, null), rob(R4, owner.subject, { project_id: projectId })], next_cursor: null };
                return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
            },
            get: async () => ({ status: 404, body: {} }),
        };
        const index = createResourceIndexService({ config: t.ctx.config, authorities: { list: () => [] }, tokens: null, self: careless, log: { warn() {} } });
        const direct = await index.list({ owner: owner.subject });
        assert.deepStrictEqual(direct.resources.map((x) => x.id), [R1], 'only the owner\'s, and only outside a project');
        assert.strictEqual(seen[0].searchParams.get('owner'), owner.subject, 'owner is asked of the authority');

        const kept = t.ctx.index;
        t.ctx.index = index;
        try {
            const r = await t.get('/projects/mine', { as: owner });
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.match(r.text, /<h1>Your resources<\/h1>/);
            assert.ok(r.text.includes(R1) && !r.text.includes(R2) && !r.text.includes(R3) && !r.text.includes(R4), 'the person\'s own row only');
            assert.ok(!r.text.includes('<th scope="col">Owner</th>'), 'no owner column: all of it is theirs');
            assert.strictEqual(seen.at(-1).searchParams.get('owner'), owner.subject, 'the signed-in person\'s subject, never a query value');
            const forged = await t.get(`/projects/mine?owner=${bob.subject}`, { as: owner });
            assert.ok(!forged.text.includes(R2), 'a query cannot name someone else');
            assert.strictEqual(seen.at(-1).searchParams.get('owner'), owner.subject);
            const b = await t.get('/projects/mine', { as: bob });
            assert.ok(b.text.includes(R2) && !b.text.includes(R1), 'each person sees their own');
            assert.strictEqual((await t.get('/projects/mine')).status, 401, 'signed out: sign in');
            const list = await t.get('/projects', { as: owner });
            assert.ok(list.text.includes('<a href="/projects/mine">Your resources</a>'), 'the projects page links it');
        } finally { t.ctx.index = kept; }
    });

    t.ctx.index.list = realList;
    await done(t);
})();
