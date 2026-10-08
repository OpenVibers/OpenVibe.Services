'use strict';

/**
 * OpenVibe.Services configuration. Everything comes from the environment (.env in development,
 * /etc/openvibe/services.env in production). loadConfig(env) is pure so tests build their own. Only environment
 * variable NAMES appear in code and docs; secrets are never logged.
 *
 * Services is the developer platform (ADR-048, plan T13; the developer portal moved here from OpenVibe.Codes on
 * 2026-10-08): the console and docs people use in a browser, the release API apps call, and the resource index that
 * reads every authority and merges it. It owns no other service's data and stores no credential: the authority tokens
 * are Network client-credentials tokens minted per audience at call time (server/authorities/tokens.js) from
 * OV_OAUTH_CLIENT_ID / OV_OAUTH_CLIENT_SECRET, a person's own Network token is passed through to Network
 * (server/auth/api.js, server/clients/network.js), and playgrounds use the APP's token only.
 */
require('dotenv').config();
const contracts = require('openvibe-contracts');

const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const bool = (v, d = false) => (v == null || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const trim = (u) => String(u || '').replace(/\/+$/, '');
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const originOf = (id, fallback) => {
    const m = contracts.services.get(id);
    return (m && m.publicOrigin) || fallback;
};

/**
 * SERVICES_<ID>_URL overrides one authority's loopback origin (the id uppercased, '-' -> '_'), e.g.
 * SERVICES_NETWORK_URL=http://127.0.0.1:4010. The origin otherwise comes from the service manifest
 * (internalOrigin) of the pinned openvibe-contracts release. The console's own *_URL settings
 * (SERVICES_PLAYGROUND_*_URL, SERVICES_EXPORT_*_URL) name no authority and are not read here.
 */
const OWN_URL_SETTINGS = /^(PLAYGROUND|EXPORT)_/;
function authorityOrigins(env) {
    const out = {};
    for (const [k, v] of Object.entries(env)) {
        const m = /^SERVICES_([A-Z0-9]+(?:_[A-Z0-9]+)*)_URL$/.exec(k);
        if (m && v && !OWN_URL_SETTINGS.test(m[1])) out[m[1].toLowerCase().replace(/_/g, '-')] = trim(v);
    }
    return out;
}

function loadConfig(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 4930);                 // 4930 is Services'; 4000-4910 and 4920 are taken
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://openvibe.services' : `http://localhost:${port}`));
    const networkUrl = trim(env.OV_NETWORK_URL || 'https://openvibe.network');
    return {
        service: 'services',
        nodeEnv,
        isProduction,
        port,
        host: env.HOST || '127.0.0.1',
        baseUrl,
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 2,
        // Per-actor limits (server/http/actor-limits.js, roadmap WS-R task 4): the reads one caller (an
        // app, a person, else an address) may make per minute and per hour. Writes set tighter numbers there.
        limits: {
            minute: Math.max(1, int(env.SERVICES_LIMITS_MINUTE, 120)),
            hour: Math.max(1, int(env.SERVICES_LIMITS_HOUR, 3000)),
        },

        // PostgreSQL (ADR-035): DATABASE_URL is the pooled runtime role through PgBouncer (transaction
        // mode), DATABASE_DIRECT_URL the owner role on a direct connection, for migrations at boot. In
        // development without DATABASE_URL an embedded PGlite database in data/pglite is used
        // (SERVICES_PGLITE_DIR overrides the directory).
        db: {
            url: env.DATABASE_URL || '',
            directUrl: env.DATABASE_DIRECT_URL || '',
            pgliteDir: env.SERVICES_PGLITE_DIR || '',
        },
        valkey: { url: env.VALKEY_URL || '', prefix: env.VALKEY_PREFIX || 'ov:services:' },

        // OpenVibe.Network: SSO (OAuth2 authorization server with PKCE), the signing key (its JWKS), the
        // developer projects API (/api/v1/projects,
        // called with the signed-in person's own token), the registry, and client-credentials tokens
        // (Services' own and, in playgrounds, the app's).
        network: {
            url: networkUrl,
            internalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
            issuer: trim(env.OV_NETWORK_ISSUER || networkUrl),
        },
        // The audience a token for Services' API carries (the index and the release API).
        audience: env.SERVICES_AUDIENCE || 'openvibe.services',
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'services',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: 'profile',
            // Network session tokens (what /oauth/token hands Services) carry this audience; FedCM
            // assertions, app and service tokens signed with the same key do not.
            sessionAudience: env.OV_SESSION_AUDIENCE || 'openvibe.network',
        },
        cookies: { secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction },
        // Signs the per-person form token (CSRF). Unset: a random per-process key.
        formSecret: env.SERVICES_FORM_SECRET || '',

        // Staff (trust tiers): staff.site.configure (Network admins), plus these subjects (usr_…).
        staffSubjects: list(env.SERVICES_STAFF_SUBJECTS),

        // Where playgrounds call, with the APP's own token (never Services' credentials). Defaults are
        // the public origins published in openvibe-contracts' service manifests.
        playground: {
            eventsUrl: trim(env.SERVICES_PLAYGROUND_EVENTS_URL || originOf('events', 'https://openvibe.events')),
            mediaUrl: trim(env.SERVICES_PLAYGROUND_MEDIA_URL || originOf('media', 'https://openvibe.media')),
            maxUploadBytes: int(env.SERVICES_PLAYGROUND_MAX_UPLOAD_BYTES, 1024 * 1024),
            runsPerHour: int(env.SERVICES_PLAYGROUND_RUNS_PER_HOUR, 60),
        },

        // The full project archive (server/domain/project-archive.js): Media and Events are read
        // server-side (loopback by default, as for /docs/limits) with Network's read-only export
        // tokens. The limits bound one archive: objects and events per environment, and how long
        // Media's signed download URLs in it stay valid (Media allows at most an hour).
        export: {
            mediaUrl: trim(env.SERVICES_EXPORT_MEDIA_URL || env.OV_MEDIA_INTERNAL_URL || 'http://127.0.0.1:4100'),
            eventsUrl: trim(env.SERVICES_EXPORT_EVENTS_URL || env.OV_EVENTS_INTERNAL_URL || 'http://127.0.0.1:4300'),
            maxObjects: Math.max(1, int(env.SERVICES_EXPORT_MAX_OBJECTS, 5000)),
            maxEvents: Math.max(1, int(env.SERVICES_EXPORT_MAX_EVENTS, 10000)),
            urlTtlS: Math.min(3600, Math.max(60, int(env.SERVICES_EXPORT_URL_TTL_S, 3600))),
        },

        // Registry answers are cached this long (Network's own health poll runs every 60 s).
        registryTtlMs: int(env.SERVICES_REGISTRY_TTL_MS, 30 * 1000),

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

        // OpenVibe.Events: the outbox relay publishes services.app.* and services.moderation.action when
        // EVENTS_URL and the client secret are set; otherwise rows wait in services_events_outbox.
        events: {
            enabled: bool(env.SERVICES_EVENTS_ENABLED, true),
            url: trim(env.EVENTS_URL || ''),
            intervalMs: Math.max(50, int(env.EVENTS_RELAY_INTERVAL_MS, 2000)),
        },

        // IndexNow (openvibe-shared/indexnow): a key makes search engines recrawl a page the moment a
        // public release appears, changes or goes away (the key file is served at /<key>.txt). Unset:
        // off, no key file, nothing sent. Tests and drills never set it.
        indexnow: { key: String(env.INDEXNOW_KEY || '').trim() },
    };
}

module.exports = { loadConfig };
