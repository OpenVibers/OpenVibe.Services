'use strict';
/**
 * Truthful readiness (GET /api/ready, openvibe-shared/ready) and the Services gauges (GET /metrics, loopback only).
 *
 *   db              required  a real query on Services' PostgreSQL store: every Services table answers
 *   docs            required  the reference was generated at boot from the pinned packages
 *   jwks            optional  openvibe-sdk/auth's JWKS cache has the Network signing key; without
 *                             it nobody can sign in and app tokens cannot be verified (docs and
 *                             tools still serve). The SDK keeps one client per URL and reports
 *                             readiness, staleness, failures and the next try for us.
 *   network         optional  the Network answers (its /.well-known/openvibe descriptor); without
 *                             it the portal shows Network's failure on every project page
 *   oauth_client    optional  OV_OAUTH_CLIENT_SECRET is set (sign-in and the events relay need it)
 *   events_relay    optional  the outbox relay is configured and has no rejected rows
 *
 * The authorities are deliberately NOT readiness checks: an authority, or Network, being down degrades
 * the index and never stops it (ADR-046 section 6). A body that could not be read is a partial page
 * (common.resource-list-result@1's `partial` array), not a red readiness — /api/v1/authorities lists the
 * registry as it stands, and the details below count it.
 *
 * Gauges: the authorities the registry reads. Counts only, never a token, never a resource.
 */
const { jwksStatus } = require('openvibe-sdk/auth');
const { createReadiness } = require('openvibe-shared/ready');
const { TABLES } = require('./db');

function createServicesReadiness({ store, network, outbox, docs, config, authorities, valkey = null, release = null }) {
    const { db } = store;
    return createReadiness({
        service: 'services',
        release,
        checks: [
            {
                name: 'db', required: true,
                // A real round trip that names the store (postgresql / pglite), and the tables present.
                check: async () => {
                    const r = await db.ready();
                    if (!r.ok) return r.error;
                    const names = new Set((await db.prepare("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()").all()).map((r) => r.name));
                    const missing = TABLES.filter((t) => !names.has(t));
                    return missing.length ? `missing ${missing.join(', ')} (migrations did not run)` : { ok: true, detail: r.detail };
                },
            },
            {
                name: 'docs', required: true,
                check: () => (docs && docs.contracts.length && docs.capabilities.length
                    ? { ok: true, detail: { contracts: docs.contractsVersion, sdk: docs.sdkVersion } }
                    : 'reference docs were not generated'),
            },
            { name: 'valkey', required: false, check: async () => (valkey ? valkey.ready() : { skipped: 'VALKEY_URL not set: per-actor limits count in this process only' }) },
            {
                name: 'network_jwks', required: false,
                // Public: counts and times only. Never the internal JWKS URL and never the SDK's
                // lastError (it names both) — the SDK logs the real error server-side.
                check: () => {
                    const statuses = jwksStatus();
                    if (!statuses.length) return 'no JWKS clients (misconfigured)';
                    const first = statuses[0];
                    if (!first.ready) return 'Network signing key not loaded yet: sign-in and token checks are unavailable';
                    return { ok: true, detail: { keys: first.keys, failures: first.failures, stale: first.stale, fetched_at: first.fetchedAt } };
                },
            },
            {
                name: 'network', required: false, cacheMs: 30_000,
                check: async () => {
                    try { await network.registry.descriptor(); return true; } catch (err) { return `OpenVibe.Network did not answer: ${network.problemOf(err).code}`; }
                },
            },
            {
                name: 'oauth_client', required: false,
                check: () => (config.oauth.clientSecret ? true : 'OV_OAUTH_CLIENT_SECRET unset: sign-in cannot complete'),
            },
            {
                name: 'events_relay', required: false,
                check: async () => {
                    const s = await outbox.status();
                    if (!s.enabled) return `relay off (EVENTS_URL or OV_OAUTH_CLIENT_SECRET unset); ${s.pending} events waiting`;
                    if (s.rejected) return `${s.rejected} events rejected by OpenVibe.Events`;
                    return { ok: true, detail: { pending: s.pending } };
                },
            },
        ],
        details: async () => ({ authorities: { count: authorities.size(), ids: authorities.ids() } }),
    });
}

/** The Services gauges on the openvibe-shared/metrics registry. */
function registerServicesGauges(registry, { authorities }) {
    registry.gauge({
        name: 'services_authorities',
        help: 'Authorities in the registry (services whose manifest lists an active <id>.resource.read)',
        collect: () => authorities.size(),
    });
    return { authorities: () => authorities.size() };
}

module.exports = { createServicesReadiness, registerServicesGauges };
