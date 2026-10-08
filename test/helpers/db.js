'use strict';
/**
 * A migrated database for one test run (ADR-035), from openvibe-sdk/testing: PGlite by default; with
 * SERVICES_TEST_STORE=pg (npm run test:pg) the PostgreSQL + PgBouncer containers, with roles and a schema of this run's own.
 */
const { createTestDb, pgAvailable } = require('openvibe-sdk/testing');
const { MIGRATIONS } = require('../../server/db');

const testDb = ({ store = process.env.SERVICES_TEST_STORE || 'pglite', max = 4 } = {}) => createTestDb({ migrations: MIGRATIONS, store, service: 'services', max });

module.exports = { testDb, pgAvailable };
