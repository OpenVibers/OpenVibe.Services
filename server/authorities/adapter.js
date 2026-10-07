'use strict';

/**
 * One authority's resource API, over its internal loopback origin (ADR-048: the index owns
 * `GET /api/v1/resources`, and every authority answers common.resource-list-result@1 /
 * common.resource-summary@1). One adapter per authority holds nothing but its origin and its token
 * lookup; it stores no resource and writes nothing on the authority.
 *
 *   fetchAs(url, opts)  the fetch openvibe-sdk/resources' createResourceIndex fans out through: the
 *                       same request, with that authority's own client-credentials token added. A token
 *                       Network cannot mint throws here, and the SDK reports this authority partial
 *                       (ADR-046 section 6) — one authority's failure never fails the whole page.
 *   get(ovrn)           GET /api/v1/resources/:ovrn → { status, body }; a transport failure is
 *                       resources.authority_unavailable (502) in the caller's terms.
 */
const { ServiceError } = require('../util');

const trim = (u) => String(u || '').replace(/\/+$/, '');

function createAuthorityAdapter(authority, { tokens, fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
    const base = trim(authority.internalOrigin);

    async function authorization() {
        const token = await tokens.get(authority);
        return token ? { Authorization: `Bearer ${token}` } : {};
    }

    /** The SDK index's fetch: the authority's token is added per request, never held in the SDK. */
    async function fetchAs(url, opts = {}) {
        return fetchImpl(url, { ...opts, headers: { ...(opts.headers || {}), ...(await authorization()) } });
    }

    /** GET /api/v1/resources/:ovrn — the one-resource read, straight from the authority that owns it. */
    async function get(ovrn) {
        const url = `${base}/api/v1/resources/${encodeURIComponent(ovrn)}`;
        let res;
        try {
            res = await fetchImpl(url, {
                headers: { Accept: 'application/json', ...(await authorization()) },
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (err) {
            throw new ServiceError(502, 'resources.authority_unavailable', `${authority.id} did not answer (${err.message})`);
        }
        const body = await res.json().catch(() => null);
        return { status: res.status, body };
    }

    return { authority, origin: base, fetchAs, get };
}

/** The one fetch createResourceIndex fans out through: the URL's own authority adds its token. */
function createAuthorityFetcher(adapters) {
    return async (url, opts) => {
        const target = adapters.find((a) => String(url).startsWith(`${a.origin}/`));
        if (!target) throw new Error(`no authority serves ${url}`);
        return target.fetchAs(url, opts);
    };
}

module.exports = { createAuthorityAdapter, createAuthorityFetcher };
