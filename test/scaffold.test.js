'use strict';
/**
 * The kernel around the resource index (plan T13 step 3): liveness, truthful readiness, the release
 * manifest, the loopback-only /metrics, the problem+json surface and the token rule on the index.
 *
 *   node test/scaffold.test.js
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');

async function main() {
    const t = await boot();
    try {
        await check('liveness: GET /api/health says only what it can back', async () => {
            const r = await t.call('GET', '/api/health', { token: null });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json.status, 'ok');
            assert.strictEqual(r.json.service, 'services');
            assert.strictEqual(r.json.version, require('../package.json').version);
            assert.strictEqual(r.json.authorities, 0);                       // no authority in this boot
            assert.strictEqual(r.json.events.enabled, false);                // EVENTS_URL unset in the test
            assert.strictEqual(r.json.events.pending, 0);                    // nothing has happened in this boot
        });

        await check('readiness: GET /api/ready requires the database and the docs; the rest degrades, never fails', async () => {
            const r = await t.call('GET', '/api/ready', { token: null });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json.ready, true, r.text);
            assert.strictEqual(r.json.service, 'services');
            for (const name of ['db', 'docs']) {
                assert.strictEqual(r.json.checks[name].status, 'ok', name);
                assert.strictEqual(r.json.checks[name].required, true, name);
            }
            assert.strictEqual(r.json.checks.network_jwks.status, 'ok');     // the stub Network's key is loaded
            assert.strictEqual(r.json.checks.network_jwks.required, false);  // docs and tools serve without it
            assert.deepStrictEqual(r.json.failed, []);
            // The relay is off in this boot (no EVENTS_URL): reported as degraded, never as ready.
            assert.ok(r.json.degraded.includes('events_relay'), r.text);
            assert.deepStrictEqual(r.json.authorities, { count: 0, ids: [] });
        });

        await check('GET /release.json serves the manifest for this release', async () => {
            const r = await t.call('GET', '/release.json', { token: null });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json.service, 'services');
            assert.strictEqual(r.json.contracts_version, require('openvibe-contracts/package.json').version);
            assert.strictEqual(r.json.packages['openvibe-sdk'], require('openvibe-sdk/package.json').version);
            assert.ok(r.json.components.server, 'the release names its server component');
        });

        await check('GET /metrics is for a direct loopback caller, never a forwarded one', async () => {
            const direct = await t.call('GET', '/metrics', { token: null });
            assert.strictEqual(direct.status, 200, direct.text);
            assert.match(direct.headers.get('content-type') || '', /text\/plain/);
            assert.match(direct.text, /services_authorities/);
            assert.match(direct.text, /release_info/);
            for (const header of ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'forwarded']) {
                const forwarded = await t.call('GET', '/metrics', { token: null, headers: { [header]: '203.0.113.7' } });
                assert.strictEqual(forwarded.status, 404, `${header} must not reach /metrics`);
            }
            const under = await t.call('GET', '/metrics/nope', { token: null });
            assert.strictEqual(under.status, 404);
        });

        await check('an unknown API route is a problem+json 404; an unknown page is an HTML 404', async () => {
            for (const p of ['/api/v1/nope', '/api/nope']) {
                const r = await t.call('GET', p, { token: null });
                assert.strictEqual(r.status, 404, `${p}: ${r.text}`);
                assert.match(r.headers.get('content-type') || '', /application\/problem\+json/, p);
                assert.strictEqual(r.json.code, 'route.not_found', p);
                assert.ok(r.json.request_id, p);
            }
            for (const p of ['/console', '/nope']) {
                const r = await t.call('GET', p, { token: null });
                assert.strictEqual(r.status, 404, `${p}: ${r.text.slice(0, 200)}`);
                assert.match(r.headers.get('content-type') || '', /text\/html/, p);
            }
        });

        await check('the index without a token is 401 token.missing', async () => {
            const ovrn = `ovrn:alpha:${ids.newId('project')}:task/${ids.newId('task')}`;
            // An OVRN carries a '/', so a path parameter spells it URL-encoded (as the console will).
            for (const p of ['/api/v1/resources', `/api/v1/resources/${encodeURIComponent(ovrn)}`, '/api/v1/authorities']) {
                const r = await t.call('GET', p, { token: null });
                assert.strictEqual(r.status, 401, `${p}: ${r.text}`);
                assert.strictEqual(r.json.code, 'token.missing');
            }
        });

        await check('a service token without services.resource.read is 403 capability.denied', async () => {
            const r = await t.call('GET', '/api/v1/resources', { cap: ['media.object.read'] });
            assert.strictEqual(r.status, 403, r.text);
            assert.strictEqual(r.json.code, 'capability.denied');
        });

        await check('an app token is refused even with the grant: the index is first-party service tokens or a person', async () => {
            const project = ids.newId('project');
            const appToken = t.network.signService({ sub: `app:${ids.newId('app')}`, actor_type: 'app', project_id: project, env: 'production' });
            const r = await t.call('GET', `/api/v1/resources?project=${project}`, { token: appToken });
            assert.strictEqual(r.status, 403, r.text);
            assert.strictEqual(r.json.code, 'capability.denied');
            assert.match(r.json.detail, /first-party/);
        });

        await check('a token for another audience is refused, never downgraded', async () => {
            const r = await t.call('GET', '/api/v1/resources', { token: t.network.signService({ aud: ['openvibe.media'] }) });
            assert.strictEqual(r.status, 401, r.text);
            assert.ok(['token.wrong_audience', 'token.invalid'].includes(r.json.code), r.text);
        });

        await check('a person with no project is 400 resources.project_required, never an unscoped read', async () => {
            const r = await t.call('GET', '/api/v1/resources', { user: {} });
            assert.strictEqual(r.status, 400, r.text);
            assert.strictEqual(r.json.code, 'resources.project_required');
        });

        await check('the authority registry is first-party: a person does not get it', async () => {
            const r = await t.call('GET', '/api/v1/authorities', { user: {} });
            assert.strictEqual(r.status, 403, r.text);
            assert.strictEqual(r.json.code, 'capability.denied');
        });

        await check('the skeleton sends the security headers an API should', async () => {
            const r = await t.call('GET', '/api/health', { token: null });
            assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
            assert.ok(r.headers.get('x-frame-options'));
            assert.strictEqual(r.headers.get('x-powered-by'), null);
            assert.match(r.headers.get('x-openvibe-request-id') || '', /^req_[0-9a-f]{24}$/);
        });
    } finally {
        await t.close();
    }

    // A second boot with a broken registry input: an empty authority set answers an empty page, not a crash.
    const empty = await boot({ env: { OV_OAUTH_CLIENT_SECRET: '' } });
    try {
        await check('with no OAuth secret the index still serves (an empty registry is an empty page)', async () => {
            const r = await empty.call('GET', '/api/v1/resources', {});
            assert.strictEqual(r.status, 200, r.text);
            assert.deepStrictEqual(r.json, { resources: [], next_cursor: null });
            assert.strictEqual(empty.app.locals.tokens.enabled, false);
        });
    } finally {
        await empty.close();
    }
    done();
}

main().catch((e) => { console.error(e); process.exit(1); });
