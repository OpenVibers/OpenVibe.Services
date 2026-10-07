'use strict';

/**
 * The authority registry (ADR-048, plan T13 step 6): which services Services may aggregate and call,
 * and where each one listens.
 *
 * An authority is a service whose released openvibe-contracts manifest lists `<id>.resource.read` as
 * `active`. At v0.110.0 that is network, media, events, host and codes; the moment a service's manifest
 * (and its capability manifest) turn that on, it is in this registry on the next boot — nothing here is
 * hand-maintained, and nothing here is another service's data. Services itself is never an authority:
 * it reads authorities, it does not index itself. A `retired` or `placeholder` service is not called.
 *
 * The loopback origin comes from the manifest (`internalOrigin`, e.g. http://127.0.0.1:4100 for Media);
 * SERVICES_<ID>_URL overrides it for the operator (config.authorityOrigins). The audience Services
 * mints a token for is openvibe.<id> — the Network client-credentials audience of that service.
 */
const contracts = require('openvibe-contracts');

const RESOURCE_READ = /^([a-z][a-z0-9-]{0,31})\.resource\.read$/;
const trim = (u) => String(u || '').replace(/\/+$/, '');

function createAuthorities(config, { log = console } = {}) {
    const byId = new Map();
    for (const m of contracts.services.manifests) {
        if (!m || typeof m.id !== 'string') continue;
        if (m.id === 'services') continue;                                   // Services reads authorities, not itself
        if (m.status === 'retired' || m.status === 'placeholder') continue;
        const capId = `${m.id}.resource.read`;
        if (!Array.isArray(m.capabilities) || !m.capabilities.includes(capId)) continue;
        const manifest = RESOURCE_READ.test(capId) ? contracts.capabilities.get(capId) : null;
        if (!manifest || manifest.status !== 'active') continue;             // listed but not active: not an authority yet
        const internalOrigin = trim((config.authorityOrigins && config.authorityOrigins[m.id]) || m.internalOrigin);
        if (!internalOrigin) {
            log.warn(`[Services] ${m.id} lists ${capId} but names no internalOrigin: it is left out of the registry`);
            continue;
        }
        byId.set(m.id, Object.freeze({
            id: m.id,
            name: m.name || m.id,
            internalOrigin,
            publicOrigin: m.publicOrigin || null,
            audience: `openvibe.${m.id}`,
            capability: capId,
            manifestVersion: m.version || null,
            contractsRange: (m.contractRanges || {})['openvibe-contracts'] || null,
            status: m.status,
        }));
    }
    const list = () => [...byId.values()];
    return {
        list,
        get: (id) => byId.get(id) || null,
        ids: () => [...byId.keys()],
        size: () => byId.size,
    };
}

module.exports = { createAuthorities, RESOURCE_READ };
