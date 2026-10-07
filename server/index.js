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
 * The authority registry is built here from the pinned openvibe-contracts service manifests
 * (server/authorities/index.js) and logged, so the boot line says what this instance will fan out over.
 * There is no polling loop: the index reads the authorities on each request (plan T13 step 6), and the
 * rebuildable read model is step 7.
 */
const { loadConfig } = require('./config');
const { openDb, migrate } = require('./db');
const { createApp } = require('./app');
const { gracefulStop } = require('openvibe-sdk/service');
const { createRegistry } = require('openvibe-shared/metrics');

async function main() {
    const config = loadConfig();
    const registry = createRegistry();
    const db = openDb(config, { registry });
    const m = await migrate(config, { serving: db });
    if (m.held.length) console.warn(`[Services] migrations held: ${m.held.map((h) => `${h.id} (${h.reason})`).join('; ')}`);

    const app = createApp({ config, db, registry });
    const { keys, outbox, authorities, tokens } = app.locals;
    keys.start();
    outbox.start();

    const server = app.listen(config.port, config.host, () => {
        console.log(`[Services] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (store ${db.store})`);
        console.log(`[Services] authorities ${authorities.size()}: ${authorities.ids().join(', ') || 'none'}; authority tokens ${tokens.enabled ? `client ${config.oauth.clientId}` : 'off (OV_OAUTH_CLIENT_SECRET unset: authorities are reported partial)'}; outbox ${outbox.enabled ? `→ ${config.events.url}` : 'idle (no event type declared)'}`);
    });
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
    server.requestTimeout = 40_000;

    // systemd sends SIGTERM (SIGINT by hand); openvibe-sdk/service's gracefulStop takes the signal, runs
    // the stop steps in order (nothing new starts), drains the HTTP server, then the close steps and
    // exits. Services' manifest declares no lifecycle.shutdown deadline, so the kit's default fits.
    const { stop: shutdown } = gracefulStop({
        name: 'Services',
        server,
        drainMs: 4000,
        deadlineMs: 5000,
        deadlineExitCode: 0,
        stop: [
            () => keys.stop(),
            () => outbox.stop(),
        ],
        close: [
            () => db.close().catch(() => {}),
        ],
    });
    return { app, server, shutdown };
}

if (require.main === module) {
    main().catch((e) => {
        console.error(`[Services] could not start: ${e.message}`);
        process.exit(1);
    });
}

module.exports = { main };
