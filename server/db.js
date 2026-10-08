'use strict';

/**
 * Services' own PostgreSQL database (ADR-035), through openvibe-sdk/db: async, pooled, one dialect.
 *
 * The schema is migrations/NNNN_*.sql, applied at boot by migrate() on the owner's direct connection
 * (DATABASE_DIRECT_URL); the service then serves on the pooled runtime role (DATABASE_URL, PgBouncer in
 * transaction mode). Nothing here is another service's data (ADR-048):
 *   0001  the authority registry, the rebuildable resource read model, recipes and the control log
 *   0002  the console's own records (ADR-014, moved from OpenVibe.Codes): release metadata keyed to Network app
 *         ids, trust tiers (metadata, never authority), validated manifests and playground run logs. Projects,
 *         members, apps, credentials, grants and quotas belong to OpenVibe.Network and are never copied here.
 *
 * No table has a column for a secret, token or credential, and nothing written here ever contains one
 * (test/secrets.test.js scans every console table).
 *
 *   openDb(config)             the serving handle: DATABASE_URL; in development without it, an
 *                              embedded PGlite database in data/pglite (one process)
 *   migrate(config, {serving}) apply migrations/ with the owner role, then close that connection
 *   createStore(db, {now})     the console's handle: the db, an injectable clock, ids, transactions
 */
const fs = require('fs');
const path = require('path');
const { createDb } = require('openvibe-sdk/db');
const { ids } = require('openvibe-contracts');

const TABLES = ['manifests', 'releases', 'release_log', 'trust', 'trust_history', 'playground_runs'];

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const DEV_PGLITE = path.join(__dirname, '..', 'data', 'pglite');

function openDb(config, { registry, log = console } = {}) {
    if (!config.db.url) {
        if (config.isProduction) throw new Error('DATABASE_URL is not set: production serves from PostgreSQL (OpenVibe.Host roles/data add-service.sh services)');
        const dir = config.db.pgliteDir || DEV_PGLITE;
        log.warn(`[Services] DATABASE_URL unset: embedded PGlite database in ${dir} (development only, one process)`);
        fs.mkdirSync(dir, { recursive: true });
        return createDb({ pglite: dir, service: 'services', registry, log });
    }
    return createDb({ url: config.db.url, service: 'services', registry, log });
}

/** Apply pending migrations; several processes starting together are serialised by the SDK's lock. */
async function migrate(config, { serving = null, log = console } = {}) {
    if (serving && serving.store === 'pglite') return serving.migrate({ dir: MIGRATIONS, log });
    if (!config.db.directUrl) throw new Error('DATABASE_DIRECT_URL is not set: migrations run with the owner role on a direct connection');
    const owner = createDb({ url: config.db.directUrl, service: 'services-migrate', max: 1, log });
    try { return await owner.migrate({ dir: MIGRATIONS, log }); } finally { await owner.close(); }
}

/**
 * The console's handle on a migrated database. opts.now — injectable clock (epoch ms), so tests and replays are
 * deterministic. store.tx(fn) is a transaction; inside it, plain db calls join it (ambient).
 */
function createStore(db, { now = () => Date.now() } = {}) {
    return {
        db,
        now,
        iso: () => new Date(now()).toISOString(),
        newId: (prefix) => `${prefix}_${ids.ulid(now())}`,
        tx: async (fn) => await db.tx(() => fn()),
        close: () => db.close(),
    };
}

module.exports = { openDb, migrate, createStore, MIGRATIONS, TABLES };
