'use strict';

/**
 * OpenVibe.Services configuration. Everything comes from the environment (.env in development,
 * /etc/openvibe/services.env in production). loadConfig(env) is pure so tests build their own.
 *
 * Services is the resource control plane (ADR-048, plan T13): it reads every authority's resource index
 * and merges it. It owns no other service's data and stores no credential: the authority tokens are
 * Network client-credentials tokens minted per authority audience at call time (server/authorities/tokens.js)
 * from OV_OAUTH_CLIENT_ID / OV_OAUTH_CLIENT_SECRET, and the person-facing path passes the caller's own
 * Network user token through to Network (server/auth.js).
 */
require('dotenv').config();

const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const bool = (v, d = false) => (v == null || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const trim = (u) => String(u || '').replace(/\/+$/, '');
/** A PEM in an environment variable carries its newlines escaped. */
const pem = (v) => (v ? String(v).replace(/\\n/g, '\n') : null);

/**
 * SERVICES_<ID>_URL overrides one authority's loopback origin (the id uppercased, '-' -> '_'), e.g.
 * SERVICES_NETWORK_URL=http://127.0.0.1:4010. The origin otherwise comes from the service manifest
 * (internalOrigin) of the pinned openvibe-contracts release.
 */
function authorityOrigins(env) {
    const out = {};
    for (const [k, v] of Object.entries(env)) {
        const m = /^SERVICES_([A-Z0-9]+(?:_[A-Z0-9]+)*)_URL$/.exec(k);
        if (m && v) out[m[1].toLowerCase().replace(/_/g, '-')] = trim(v);
    }
    return out;
}

function loadConfig(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 4930);                 // 4930 is Services'; 4000-4910 and 4920 are taken
    const networkUrl = trim(env.OV_NETWORK_URL || 'https://openvibe.network');
    return {
        nodeEnv,
        isProduction,
        port,
        host: env.HOST || '127.0.0.1',
        baseUrl: trim(env.BASE_URL || (isProduction ? 'https://openvibe.services' : `http://localhost:${port}`)),
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 1,

        // PostgreSQL (ADR-035): DATABASE_URL is the pooled runtime role through PgBouncer (transaction
        // mode), DATABASE_DIRECT_URL the owner role on a direct connection, for migrations at boot.
        db: {
            url: env.DATABASE_URL || '',
            directUrl: env.DATABASE_DIRECT_URL || '',
        },

        // Identity: the Network signing key verifies every incoming token; NETWORK_URL is the origin the
        // person-facing path asks about project membership (GET /api/v1/projects/:project, with the
        // caller's own token — the developer projects API).
        network: {
            url: networkUrl,
            internalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
            issuer: trim(env.OV_NETWORK_ISSUER || networkUrl),
            publicKey: pem(env.OV_NETWORK_PUBLIC_KEY),
        },
        audience: env.SERVICES_AUDIENCE || 'openvibe.services',

        // Services' own Network client (`services`): it mints the per-authority client-credentials
        // tokens. Unset in development: the fan-out reaches the authorities without a token and an
        // authority that refuses is reported partial, never fatal (ADR-046 section 6).
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'services',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
        },

        // One authority's loopback origin override (see authorityOrigins); the manifest's internalOrigin
        // is the default.
        authorityOrigins: authorityOrigins(env),

        // The resource index (plan T13 step 6): the per-authority page size the fan-out asks for, how
        // many authorities are read at once, and how long one authority may take before it is reported
        // partial instead of failing the page. `pageLimit` is the caller-facing default and ceiling.
        index: {
            pageSize: Math.max(1, int(env.SERVICES_INDEX_PAGE_SIZE, 100)),
            concurrency: Math.max(1, int(env.SERVICES_INDEX_CONCURRENCY, 4)),
            timeoutMs: Math.max(1, int(env.SERVICES_INDEX_TIMEOUT_MS, 5000)),
            defaultLimit: Math.max(1, int(env.SERVICES_INDEX_DEFAULT_LIMIT, 100)),
            maxLimit: Math.max(1, int(env.SERVICES_INDEX_MAX_LIMIT, 1000)),
            networkTimeoutMs: Math.max(1, int(env.SERVICES_NETWORK_TIMEOUT_MS, 5000)),
        },

        // The outbox relay. Services declares no event type yet (plan T13 step 10), so the relay is
        // idle; EVENT_URL unset (or the OAuth client secret unset) keeps rows in the table.
        events: {
            enabled: bool(env.SERVICES_EVENTS_ENABLED, true),
            url: trim(env.EVENTS_URL || ''),
            intervalMs: Math.max(250, int(env.EVENTS_RELAY_INTERVAL_MS, 2000)),
        },
    };
}

module.exports = { loadConfig };
