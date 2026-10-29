'use strict';
/**
 * /openapi.json documents this service's API, and the document is the API: every route it lists is a
 * route the app mounts, and every mounted /api/v1 route is listed (the probes and the
 * /api/v1/openapi.json redirect excepted). The mounted set is read from the real Express stack, so a
 * route added, renamed or removed without the document fails here.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { routes, MOUNT } = require('../server/http/openapi');

/** The path an app.use(...) layer mounts its router at, decoded from Express's compiled regexp. */
function mountOf(layer) {
    const source = String((layer.regexp && layer.regexp.source) || '');
    if (layer.regexp && layer.regexp.fast_slash) return '';
    const m = /^\^(.*?)\\\/\?\(\?=\\\/\|\$\)$/.exec(source);
    assert.ok(m, `cannot read the mount path of a router layer (${source})`);
    return m[1].replace(/\\\//g, '/').replace(/\\\./g, '.');
}

/** ":param" as OpenAPI writes it, "{param}". */
const templated = (p) => String(p).replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');

/** Every "METHOD /path" the app answers, routers included. */
function mounted(app) {
    const out = new Set();
    const walk = (stack, prefix) => {
        for (const layer of stack) {
            if (layer.route) {
                for (const [method, on] of Object.entries(layer.route.methods)) {
                    if (!on || method === '_all') continue;
                    for (const p of [].concat(layer.route.path)) out.add(`${method.toUpperCase()} ${prefix}${templated(p)}`);
                }
            } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
                walk(layer.handle.stack, prefix + mountOf(layer));
            }
        }
    };
    assert.ok(app._router && app._router.stack, 'the app has a router');
    walk(app._router.stack, '');
    return out;
}

const LEFT_OUT = new Set(['GET /api/health', 'GET /api/ready', 'GET /api/v1/openapi.json']);
/** The resource-index router is mounted behind a path gate, so the stack walk cannot see it: it is
 * proved mounted by calling each route (an unmatched route answers 404). */
const GATED = new Set([
    'GET /api/v1/resources', 'POST /api/v1/resources/control', 'GET /api/v1/resources/{ovrn}', 'GET /api/v1/authorities',
]);

(async () => {
    const t = await boot({ authorities: [] });
    try {
        let doc = null;
        await check('/openapi.json is served as cached JSON', async () => {
            const r = await t.call('GET', '/openapi.json', { token: null });
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('content-type'), 'application/json; charset=utf-8');
            assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=300');
            doc = r.json;
            assert.strictEqual(doc.openapi, '3.1.0');
            assert.ok(doc.paths && typeof doc.paths === 'object');
            assert.ok(Object.keys(doc.paths).length > 0, 'paths is not empty');
            assert.strictEqual(doc.info.title, 'OpenVibe.Services API');
            assert.deepStrictEqual(doc.servers, [{ url: 'https://openvibe.services' }]);
        });

        await check('every documented route is mounted, with an operationId and responses', async () => {
            const live = new Set(mounted(t.app));
            for (const [p, item] of Object.entries(doc.paths)) {
                assert.ok(p.startsWith('/api/'), `${p} is outside /api`);
                for (const [method, op] of Object.entries(item)) {
                    assert.ok(op.operationId, `${method.toUpperCase()} ${p} has an operationId`);
                    assert.ok(op.responses && Object.keys(op.responses).length, `${method.toUpperCase()} ${p} describes its responses`);
                    if (!GATED.has(`${method.toUpperCase()} ${p}`)) assert.ok(live.has(`${method.toUpperCase()} ${p}`), `${method.toUpperCase()} ${p} is documented but not mounted`);
                }
            }
        });

        await check('every mounted /api/v1 route is documented', async () => {
            const documented = Object.entries(doc.paths).flatMap(([p, item]) => Object.keys(item).map((m) => `${m.toUpperCase()} ${p}`)).sort();
            const live = [...mounted(t.app)].filter((key) => key.split(' ')[1].startsWith(`${MOUNT}/`) && !LEFT_OUT.has(key) && !GATED.has(key)).sort();
            assert.deepStrictEqual(live, documented.filter((key) => !GATED.has(key)));
            assert.deepStrictEqual(documented, routes(), 'server/http/openapi.js routes() and the document agree');
            for (const key of GATED) assert.ok(documented.includes(key), `${key} is documented`);
        });

        await check('the gated resource-index routes answer (are mounted)', async () => {
            const probe = [
                ['GET', '/api/v1/resources'], ['GET', '/api/v1/authorities'], ['GET', '/api/v1/resources/x'],
                ['POST', '/api/v1/resources/control'],
            ];
            for (const [method, p] of probe) {
                const r = await t.call(method, p, { body: method === 'POST' ? {} : undefined });
                assert.notStrictEqual(r.status, 404, `${method} ${p} is not mounted`);
            }
        });

        await check('/api/v1/openapi.json redirects to it', async () => {
            const r = await fetch(`${t.base}/api/v1/openapi.json`, { redirect: 'manual' });
            assert.strictEqual(r.status, 308);
            assert.strictEqual(r.headers.get('location'), '/openapi.json');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((err) => { console.error(err); process.exitCode = 1; });
