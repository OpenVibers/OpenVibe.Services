'use strict';

/**
 * Services' own PostgreSQL database (ADR-035), through openvibe-sdk/db: async, pooled, one dialect.
 *
 * The schema is migrations/NNNN_*.sql, applied at boot by migrate() on the owner's direct connection
 * (DATABASE_DIRECT_URL); the service then serves on the pooled runtime role (DATABASE_URL, PgBouncer in
 * transaction mode). Services is new: migrations/0001_initial.sql is written as the final schema, no
 * window. Nothing here is another service's data (ADR-048): the authority registry, the rebuildable
 * resource read model, recipes and the control log are Services' own rows.
 *
 *   openDb(config)             the serving handle: DATABASE_URL; in development without it, an
 *                              embedded PGlite database in data/pglite (one process)
 *   migrate(config, {serving}) apply migrations/ with the owner role, then close that connection
 */
const fs = require('fs');
const path = require('path');
const { createDb } = require('openvibe-sdk/db');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const DEV_PGLITE = path.join(__dirname, '..', 'data', 'pglite');

function openDb(config, { registry, log = console } = {}) {
    if (!config.db.url && !config.isProduction) {
        log.warn(`[Services] DATABASE_URL unset: embedded PGlite database in ${DEV_PGLITE} (development only, one process)`);
        fs.mkdirSync(DEV_PGLITE, { recursive: true });
        return createDb({ pglite: DEV_PGLITE, service: 'services', registry, log });
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

module.exports = { openDb, migrate, MIGRATIONS };
