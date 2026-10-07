'use strict';
/**
 * Boots Services against the stub Network and the stub authorities a test names, on a random port, with a
 * migrated database of its own (helpers/db.js: PGlite, or the containers with SERVICES_TEST_STORE=pg).
 * The key refresher and the outbox relay are NOT started (server/index.js starts them in production);
 * the JWKS is loaded once, so the app verifies tokens the way it does in production — through the stub
 * Network's own key, never a bypass.
 *
 *   const t = await boot({ authorities: [{ id: 'alpha', resources: [...] }, …] });
 *   t.call(method, path, { token | cap, sub, project, user, headers })   an HTTP call with a service or
 *                                                                        user token the stub Network signed
 *   t.network                       the stub Network (mints, signService, signUser, addMember)
 *   t.authority('alpha')            the stub authority: .url, .calls, .resources
 *   t.base, t.db                    the URL and the migrated database
 *
 * The default page size is deliberately small (SERVICES_INDEX_PAGE_SIZE=2), so a fan-out walks more than
 * one page per authority unless a test says otherwise.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { ids } = require('openvibe-contracts');
const { testDb } = require('./db');
const { startNetwork, startAuthority, registryOf } = require('./stubs');

/** A fresh prj_ id (the tenancy boundary of every fixture). */
const newProject = () => ids.newId('project');

async function boot(opts = {}) {
    const network = await startNetwork(opts.network || {});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'services-test-'));
    const env = {
        NODE_ENV: 'test',
        BASE_URL: 'http://services.test',
        OV_NETWORK_URL: network.url,
        OV_NETWORK_INTERNAL_URL: network.url,
        OV_NETWORK_ISSUER: network.issuer,
        OV_OAUTH_CLIENT_ID: 'services',
        OV_OAUTH_CLIENT_SECRET: 'services-secret',
        SERVICES_INDEX_TIMEOUT_MS: '400',
        SERVICES_INDEX_PAGE_SIZE: '2',          // small: the tests exercise the cursor walk
        SERVICES_INDEX_CONCURRENCY: '2',
        ...(opts.env || {}),
    };
    for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}server${path.sep}`)) delete require.cache[k];
    const { loadConfig } = require('../../server/config');
    const { createApp } = require('../../server/app');
    const config = loadConfig(env);
    const logs = [];
    const log = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };

    const stubs = [];
    for (const a of opts.authorities || []) stubs.push(await startAuthority(a));
    const authorities = opts.registry || registryOf(stubs);
    const store = opts.db ? { db: opts.db, store: opts.db.store, close: async () => {} } : await testDb({ store: opts.store });
    const app = createApp({ config, db: store.db, authorities, log, ...(opts.appOpts || {}) });
    await app.locals.keys.load();

    const server = await new Promise((resolve) => {
        const s = http.createServer(app);
        s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;

    async function call(method, p, { body, token, cap = ['services.resource.read'], sub = 'svc:console', project, user, headers = {} } = {}) {
        const h = { ...headers };
        if (token !== null) h.Authorization = `Bearer ${token || (user ? network.signUser(user) : network.signService({ cap, sub, ...(project ? { project_id: project } : {}) }))}`;
        if (body !== undefined) h['Content-Type'] = 'application/json';
        const res = await fetch(base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
        return { status: res.status, headers: res.headers, json, text };
    }

    return {
        app, base, call, db: store.db, store, config, network, logs, dir,
        authority: (id) => stubs.find((s) => s.id === id) || null,
        authorities: stubs,
        wait: (ms) => new Promise((r) => setTimeout(r, ms)),
        close: async () => {
            server.closeAllConnections();
            await new Promise((r) => server.close(r));
            await app.locals.outbox.stop();
            for (const s of stubs) await s.close();
            await network.close();
            await store.close();
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); }
    catch (e) { failures++; console.log('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')); }
}
function done() { console.log(failures ? `\n${failures} failed` : '\nall passed'); process.exit(failures ? 1 : 0); }

module.exports = { boot, check, done, newProject };
