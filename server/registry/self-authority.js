'use strict';
/**
 * Services as the authority of its own resources (manifests and releases: ADR-048's services.manifest and
 * services.release), read by the merged index IN PROCESS. The fan-out's fetch for this origin never leaves the
 * process and the one-resource read calls the same function; reading itself over HTTP would mint a token for its
 * own audience and go out through nginx and back for nothing.
 *
 * It has the shape server/authorities/adapter.js gives every other authority: { authority, origin, fetchAs, get }.
 */
const own = require('./resource-index');

const ORIGIN = 'http://services.in-process';

function createSelfAuthority({ store }) {
    const authority = Object.freeze({
        id: own.SERVICE,
        name: 'OpenVibe.Services',
        internalOrigin: ORIGIN,
        publicOrigin: 'https://openvibe.services',
        audience: 'openvibe.services',
        capability: own.RESOURCE_READ,
        manifestVersion: null,
        contractsRange: null,
        status: 'in-process',
    });
    const json = ({ status, body }) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    /** The index's fetch for this origin: GET /api/v1/resources[?…] and GET /api/v1/resources/:ovrn. */
    async function fetchAs(url) {
        const u = new URL(url);
        if (u.pathname === '/api/v1/resources') return json(await own.pageOf(store.db, Object.fromEntries(u.searchParams)));
        const m = /^\/api\/v1\/resources\/([^/]+)$/.exec(u.pathname);
        if (m) return json(await own.oneOf(store.db, decodeURIComponent(m[1])));
        return json({ status: 404, body: { code: 'route.not_found' } });
    }

    return { authority, origin: ORIGIN, fetchAs, get: (ovrn) => own.oneOf(store.db, ovrn) };
}

module.exports = { createSelfAuthority, ORIGIN };
