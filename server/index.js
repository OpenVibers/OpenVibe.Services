'use strict';

/**
 * OpenVibe.Services — process entry. `node server/index.js`
 * Listens on PORT (4930) behind nginx (openvibe.services); see deploy/.
 *
 * Boot (ADR-035): apply migrations/ with the owner role (DATABASE_DIRECT_URL, one direct connection,
 * closed afterwards), then serve on the pooled runtime role (DATABASE_URL). Several processes may start
 * together: the migration run is serialised by an advisory lock. Nothing starts at module load — the
 * Network key refresher and the outbox relay start here, and the signal handlers stop them in order.
 *
 * The authority registry is built from the pinned openvibe-contracts service manifests
 * (server/authorities/index.js) and logged, so the boot line says what this instance will fan out over.
 * There is no polling loop: the index reads the authorities on each request (plan T13 step 6), and the
 * rebuildable read model is step 7.
 */
const { loadConfig } = require('./config');
const { openDb, migrate, createStore } = require('./db');
const { createApp } = require('./app');
const { gracefulStop } = require('openvibe-sdk/service');
const { startSubscriptions } = require('openvibe-sdk/account-data');
const { createRegistry } = require('openvibe-shared/metrics');

/**
 * The process stop (openvibe-sdk/service, docs/service.md's 5 s family): the HTTP drain runs, then the key refresher
 * and the outbox relay stop and the store closes; past the deadline the process exits 0. Exported so a test can
 * inject `exit` and `signals: false`.
 */
function createLifecycle({ server, ctx, exit, signals, extra = [] }) {
    return gracefulStop({
        name: 'Services', server, drainMs: 4000, deadlineMs: 5000, deadlineExitCode: 0, exit, signals,
        stop: [() => ctx.keys.client.stop(), () => ctx.outbox.stop(), ...extra],
        close: [() => ctx.store.close().catch(() => {})],
    });
}

async function main() {
    const config = loadConfig();
    const registry = createRegistry();
    const db = openDb(config, { registry });
    const m = await migrate(config, { serving: db });
    if (m && m.held && m.held.length) console.warn(`[Services] migrations held: ${m.held.map((h) => `${h.id} (${h.reason})`).join('; ')}`);

    const { app, ctx } = await createApp({ config, store: createStore(db), registry });
    const { authorities, tokens, outbox, keys, docs } = ctx;

    const server = app.listen(config.port, config.host, () => {
        console.log(`[Services] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (store ${db.store})`);
        console.log(`[Services] docs from openvibe-contracts v${docs.contractsVersion} and openvibe-sdk v${docs.sdkVersion}; authorities ${authorities.size()}: ${authorities.ids().join(', ') || 'none'} (+ services in process); authority tokens ${tokens.enabled ? `client ${config.oauth.clientId}` : 'off (OV_OAUTH_CLIENT_SECRET unset: authorities are reported partial)'}; events relay ${outbox.enabled ? `on → ${config.events.url}` : 'off (events wait in services_events_outbox)'}`);
    });
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
    server.requestTimeout = 40_000;
    outbox.start();
    // Keep the JWKS cache fresh in the background (openvibe-sdk/auth): one client per URL, the last
    // good keys through outages, exponential backoff, unknown-kid floods throttled, an unref'd timer.
    keys.client.start();

    // The two account subscriptions at OpenVibe.Events (ADR-033), created when missing; off without EVENTS_URL,
    // SERVICES_EVENTS_SECRET or the client secret.
    const subscriptions = startSubscriptions({
        eventsUrl: config.events.url, endpoint: `http://127.0.0.1:${config.port}/internal/events`, secret: config.events.secrets[0],
        networkInternalUrl: config.network.internalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
    });
    const { stop: shutdown } = createLifecycle({ server, ctx, extra: [() => { if (subscriptions) subscriptions.stop(); }] });
    return { app, server, ctx, shutdown };
}

if (require.main === module) {
    main().catch((e) => {
        console.error(`[Services] could not start: ${e.message}`);
        process.exit(1);
    });
}

module.exports = { main, createLifecycle };
