'use strict';

/**
 * Truthful readiness (GET /api/ready) and the Services gauges (GET /metrics, loopback only).
 *
 *   db            required  a real round trip through the pool (db.ready()) — migrations/ runs at boot
 *   network_jwks  required  the Network signing key has loaded; without it no token can be verified and
 *                           every /api/v1 route answers 503 (server/auth.js), so the service cannot
 *                           serve its one capability
 *
 * The authorities are deliberately NOT readiness checks: an authority, or Network, being down degrades
 * the index and never stops it (ADR-046 section 6). A body that could not be read is a partial page
 * (common.resource-list-result@1's `partial` array), not a red readiness — /api/v1/authorities lists the
 * registry as it stands.
 *
 * Gauges: the authorities the registry reads. Counts only, never a token, never a resource.
 */
const { createReadiness } = require('openvibe-shared/ready');

function createServicesReadiness({ db, keys, authorities, release = null }) {
    return createReadiness({
        service: 'services',
        release,
        checks: [
            { name: 'db', required: true, check: () => db.ready() },
            { name: 'network_jwks', required: true, check: () => (keys.get() ? true : 'Network signing key not loaded yet: no token can be verified') },
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
