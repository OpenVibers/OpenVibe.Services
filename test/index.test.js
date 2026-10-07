'use strict';
/**
 * The resource index over stub authorities (plan T13 step 6): the fan-out and merge (openvibe-sdk/
 * resources), the merged page and its stable cursor, the project/kind/service filters, the person-facing
 * scoping, an authority that times out or refuses (a partial page, never a failed one), the :ovrn route,
 * and the token cache (one mint per authority).
 *
 *   node test/index.test.js
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, check, done, newProject } = require('./helpers/app');
const { summary } = require('./helpers/stubs');

const ovrnsOf = (body) => body.resources.map((r) => r.ovrn);

async function main() {
    const prjA = newProject();
    const prjB = newProject();
    const alpha = [
        summary({ service: 'alpha', kind: 'alpha.repo', project: prjA }),
        summary({ service: 'alpha', kind: 'alpha.repo', project: prjB }),
        summary({ service: 'alpha', kind: 'alpha.queue', project: prjA }),
    ];
    const beta = [
        summary({ service: 'beta', kind: 'beta.object', project: prjA }),
        summary({ service: 'beta', kind: 'beta.object', project: prjA }),
    ];
    const gamma = [
        summary({ service: 'gamma', kind: 'gamma.watch', project: prjA }),
    ];
    const t = await boot({ authorities: [{ id: 'alpha', resources: alpha }, { id: 'beta', resources: beta }, { id: 'gamma', resources: gamma }] });
    try {
        await check('the merged page walks every authority with a stable cursor', async () => {
            const seen = [];
            let cursor = null;
            let pages = 0;
            do {
                const r = await t.call('GET', `/api/v1/resources?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, {});
                assert.strictEqual(r.status, 200, r.text);
                assert.strictEqual(r.headers.get('x-openvibe-partial-authorities'), null, 'no authority is partial here');
                assert.ok(r.json.resources.length <= 2, 'limit=2');
                seen.push(...ovrnsOf(r.json));
                cursor = r.json.next_cursor;
                pages++;
                assert.ok(pages <= 6, 'the walk must end');
            } while (cursor);
            assert.strictEqual(pages, 3, 'six resources, two at a time');
            const all = [...alpha, ...beta, ...gamma].map((r) => r.ovrn).sort();
            assert.deepStrictEqual(seen.slice().sort(), all, 'every resource exactly once, none invented');
            assert.deepStrictEqual(seen, all, 'a deterministic (service, ovrn, id) order');
            assert.strictEqual(seen.filter((o) => o.startsWith('ovrn:alpha:')).length, 3);
        });

        await check('the cursor is stable: the same cursor answers the same page, and repeats nothing', async () => {
            const first = await t.call('GET', '/api/v1/resources?limit=2', {});
            assert.strictEqual(first.status, 200, first.text);
            assert.ok(first.json.next_cursor, 'more pages than one');
            const second = await t.call('GET', `/api/v1/resources?limit=2&cursor=${encodeURIComponent(first.json.next_cursor)}`, {});
            const again = await t.call('GET', `/api/v1/resources?limit=2&cursor=${encodeURIComponent(first.json.next_cursor)}`, {});
            assert.deepStrictEqual(ovrnsOf(second.json), ovrnsOf(again.json), 'the same cursor, the same page');
            assert.strictEqual(ovrnsOf(second.json).length, 2);
            assert.ok(ovrnsOf(second.json).every((o) => !ovrnsOf(first.json).includes(o)), 'no resource repeats across pages');
            const firstAgain = await t.call('GET', '/api/v1/resources?limit=2', {});
            assert.deepStrictEqual(ovrnsOf(firstAgain.json), ovrnsOf(first.json));
        });

        await check('?service= reads one authority, ?kind= one kind, ?project= one project', async () => {
            const betaCalls = t.authority('beta').calls.length;
            const byService = await t.call('GET', '/api/v1/resources?service=alpha', {});
            assert.strictEqual(byService.status, 200, byService.text);
            assert.deepStrictEqual(ovrnsOf(byService.json), alpha.map((r) => r.ovrn).sort());
            assert.strictEqual(t.authority('beta').calls.length, betaCalls, '?service= never fans out to the others');

            const byKind = await t.call('GET', '/api/v1/resources?kind=beta.object', {});
            assert.strictEqual(byKind.status, 200, byKind.text);
            assert.deepStrictEqual(ovrnsOf(byKind.json), beta.map((r) => r.ovrn).sort());

            const byProject = await t.call('GET', `/api/v1/resources?project=${prjB}`, {});
            assert.strictEqual(byProject.status, 200, byProject.text);
            assert.deepStrictEqual(ovrnsOf(byProject.json), [alpha[1].ovrn]);

            const both = await t.call('GET', `/api/v1/resources?service=alpha&kind=alpha.queue&project=${prjA}`, {});
            assert.strictEqual(both.status, 200, both.text);
            assert.deepStrictEqual(ovrnsOf(both.json), [alpha[2].ovrn]);

            const unknown = await t.call('GET', '/api/v1/resources?service=nope', {});
            assert.strictEqual(unknown.status, 400, unknown.text);
            assert.strictEqual(unknown.json.code, 'resources.unknown_service');

            for (const q of ['limit=0', 'limit=100000', 'limit=x', `project=not-a-project`, 'kind=Not A Kind', 'cursor=%25%25', 'service=Bad Service']) {
                const r = await t.call('GET', `/api/v1/resources?${q}`, {});
                assert.strictEqual(r.status, 400, `${q}: ${r.text}`);
                assert.strictEqual(r.json.code, 'resources.bad_query', q);
            }
        });

        await check('a person reads only projects they belong to, one at a time', async () => {
            const ada = ids.newId('user');
            t.network.addMember(prjA, ada);

            const unscoped = await t.call('GET', '/api/v1/resources', { token: t.network.signUser({ subject: ada }) });
            assert.strictEqual(unscoped.status, 400, unscoped.text);
            assert.strictEqual(unscoped.json.code, 'resources.project_required');

            const mine = await t.call('GET', `/api/v1/resources?project=${prjA}`, { token: t.network.signUser({ subject: ada }) });
            assert.strictEqual(mine.status, 200, mine.text);
            const wanted = [...alpha, ...beta, ...gamma].filter((r) => r.project_id === prjA).map((r) => r.ovrn).sort();
            assert.deepStrictEqual(ovrnsOf(mine.json), wanted, 'only prjA rows');
            assert.ok(ovrnsOf(mine.json).includes(alpha[0].ovrn));
            assert.ok(!ovrnsOf(mine.json).includes(alpha[1].ovrn), 'the prjB row of the same authority never shows');

            const notMine = await t.call('GET', `/api/v1/resources?project=${prjB}`, { token: t.network.signUser({ subject: ada }) });
            assert.strictEqual(notMine.status, 404, notMine.text);
            assert.strictEqual(notMine.json.code, 'resources.project_not_found');
        });

        await check('an authority that ignores ?project= cannot leak another project into a person page', async () => {
            const lenient = await boot({
                authorities: [{ id: 'alpha', resources: alpha, ignoreProject: true }, { id: 'beta', resources: beta }, { id: 'gamma', resources: gamma }],
            });
            try {
                const ada = ids.newId('user');
                lenient.network.addMember(prjA, ada);
                const r = await lenient.call('GET', `/api/v1/resources?project=${prjA}`, { token: lenient.network.signUser({ subject: ada }) });
                assert.strictEqual(r.status, 200, r.text);
                assert.ok(!ovrnsOf(r.json).includes(alpha[1].ovrn), 'Services filters a row the authority should not have sent');
                assert.ok(ovrnsOf(r.json).includes(alpha[0].ovrn));
            } finally { await lenient.close(); }
        });

        await check('a slow authority is omitted and named; the rest of the page is served', async () => {
            const slow = await boot({
                authorities: [
                    { id: 'alpha', resources: alpha },
                    { id: 'beta', resources: beta, hang: true },
                    { id: 'gamma', resources: gamma },
                ],
            });
            try {
                const r = await slow.call('GET', '/api/v1/resources');
                assert.strictEqual(r.status, 200, r.text);
                assert.strictEqual(r.headers.get('x-openvibe-partial-authorities'), 'beta');
                const got = ovrnsOf(r.json);
                assert.deepStrictEqual(got.slice().sort(), [...alpha, ...gamma].map((x) => x.ovrn).sort());
                assert.deepStrictEqual(r.json.resources, r.json.resources.slice().sort((a, b) => (a.ovrn < b.ovrn ? -1 : 1)), 'partial does not disturb the order');
                // the slow authority was asked, so it is partial because it did not answer, not because it was skipped
                assert.ok(slow.authority('beta').calls.length > 0);
            } finally { await slow.close(); }

            const refusing = await boot({ authorities: [{ id: 'alpha', resources: alpha }, { id: 'beta', resources: beta, status: 503 }] });
            try {
                const r = await refusing.call('GET', '/api/v1/resources');
                assert.strictEqual(r.status, 200, r.text);
                assert.strictEqual(r.headers.get('x-openvibe-partial-authorities'), 'beta');
                assert.ok(ovrnsOf(r.json).includes(alpha[0].ovrn));
            } finally { await refusing.close(); }
        });

        await check('GET /api/v1/resources/:ovrn asks the owning authority and answers its summary', async () => {
            const target = beta[0];
            const r = await t.call('GET', `/api/v1/resources/${encodeURIComponent(target.ovrn)}`, {});
            assert.strictEqual(r.status, 200, r.text);
            assert.deepStrictEqual(r.json, target);
            const asked = t.authority('beta').calls.filter((c) => c.path === `/api/v1/resources/${encodeURIComponent(target.ovrn)}`);
            assert.strictEqual(asked.length, 1, 'asked exactly once of the owner');
            assert.match(asked[0].authorization, /^Bearer svc-token:openvibe\.beta:/, 'with the authority’s own audience token');
            assert.ok(!t.authority('alpha').calls.some((c) => c.path.includes(target.id)), 'never the other authorities');

            // the authority's 404 is the caller's 404
            const missing = { ...target, ovrn: `ovrn:beta:${target.project_id}:object/${ids.newId('watch')}` };
            const notFound = await t.call('GET', `/api/v1/resources/${encodeURIComponent(missing.ovrn)}`, {});
            assert.strictEqual(notFound.status, 404, notFound.text);
            assert.strictEqual(notFound.json.code, 'resources.not_found');
        });

        await check('a bad name or an unknown service in an OVRN is 400', async () => {
            const bad = await t.call('GET', '/api/v1/resources/not-an-ovrn', {});
            assert.strictEqual(bad.status, 400, bad.text);
            assert.strictEqual(bad.json.code, 'resources.bad_name');

            const unknown = await t.call('GET', `/api/v1/resources/${encodeURIComponent(`ovrn:mystery:${prjA}:thing/${ids.newId('task')}`)}`, {});
            assert.strictEqual(unknown.status, 400, unknown.text);
            assert.strictEqual(unknown.json.code, 'resources.unknown_service');

            // another project's OVRN parsed for a person who is not a member: 404, before any authority call
            const ada = ids.newId('user');
            const other = await t.call('GET', `/api/v1/resources/${encodeURIComponent(alpha[1].ovrn)}`, { token: t.network.signUser({ subject: ada }) });
            assert.strictEqual(other.status, 404, other.text);
        });

        await check('the token cache mints one token per authority, and reuses it', async () => {
            // A fresh boot, so the mints counted are this check's own (the cache is per process).
            const fresh = await boot({ authorities: [{ id: 'alpha', resources: alpha }, { id: 'beta', resources: beta }, { id: 'gamma', resources: gamma }] });
            try {
                const first = await fresh.call('GET', '/api/v1/resources');
                assert.strictEqual(first.status, 200, first.text);
                const mints = fresh.network.mints;
                assert.strictEqual(mints.length, 3, 'one mint per authority');
                assert.deepStrictEqual(mints.map((m) => m.audience).sort(), ['openvibe.alpha', 'openvibe.beta', 'openvibe.gamma']);
                assert.deepStrictEqual(mints.map((m) => m.scope).sort(), ['alpha.resource.read', 'beta.resource.read', 'gamma.resource.read']);
                assert.ok(mints.every((m) => m.client_id === 'services'));

                const second = await fresh.call('GET', '/api/v1/resources');
                assert.strictEqual(second.status, 200, second.text);
                assert.strictEqual(fresh.network.mints.length, 3, 'a second page walk mints nothing new');

                // and each authority only ever saw its own audience's token
                for (const [id, audience] of [['alpha', 'openvibe.alpha'], ['beta', 'openvibe.beta'], ['gamma', 'openvibe.gamma']]) {
                    const auths = new Set(fresh.authority(id).calls.map((c) => c.authorization).filter(Boolean));
                    assert.deepStrictEqual([...auths], [`Bearer svc-token:${audience}:1`], `${id} saw only its own token`);
                }
            } finally { await fresh.close(); }
        });

        await check('a Network that cannot mint a token degrades the page, it never stops it', async () => {
            const broken = await boot({ network: { failTokens: true }, authorities: [{ id: 'alpha', resources: alpha }] });
            try {
                const r = await broken.call('GET', '/api/v1/resources');
                assert.strictEqual(r.status, 200, r.text);
                assert.strictEqual(r.headers.get('x-openvibe-partial-authorities'), 'alpha');
                assert.deepStrictEqual(r.json.resources, []);
            } finally { await broken.close(); }
        });

        await check('GET /api/v1/authorities lists the registry a service token reads', async () => {
            const r = await t.call('GET', '/api/v1/authorities', {});
            assert.strictEqual(r.status, 200, r.text);
            assert.deepStrictEqual(r.json.authorities.map((a) => a.id).sort(), ['alpha', 'beta', 'gamma']);
            const a = r.json.authorities.find((x) => x.id === 'beta');
            assert.strictEqual(a.origin, t.authority('beta').url);
            assert.strictEqual(a.audience, 'openvibe.beta');
            assert.strictEqual(a.capability, 'beta.resource.read');
            assert.ok(!JSON.stringify(r.json).includes('services-secret'), 'never a secret');
        });
    } finally {
        await t.close();
    }
    done();
}

main().catch((e) => { console.error(e); process.exit(1); });
