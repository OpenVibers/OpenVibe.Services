'use strict';

/**
 * The token Services presents to an authority: a Network client-credentials token for THAT authority's
 * audience (openvibe.network, openvibe.media, …), scoped to that authority's own resource.read
 * capability. One cached token per audience, refreshed 60 s before expiry, concurrent callers sharing
 * one request — openvibe-sdk/auth's createServiceTokenClient does all of it, and it is the only place a
 * token is minted (nothing here is stored on disk or logged).
 *
 * Unset OV_OAUTH_CLIENT_SECRET in development: no client exists, get() answers null, and every authority
 * that requires a token refuses — the fan-out reports it partial, it never fails the page (ADR-046
 * section 6). Network being down behaves the same way: the mint throws, the authority is stale.
 */
const { createServiceTokenClient } = require('openvibe-sdk/auth');

const trim = (u) => String(u || '').replace(/\/+$/, '');

function createAuthorityTokens(config, { authorities, fetchImpl = globalThis.fetch } = {}) {
    const secret = config.oauth.clientSecret;
    const enabled = Boolean(config.oauth.clientId && secret);
    const client = enabled ? createServiceTokenClient({
        tokenUrl: `${trim(config.network.internalUrl)}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: secret,
        // One scope per audience: the authority's own resource.read capability (openvibe-sdk/auth: the
        // scope map is keyed by audience).
        scope: Object.fromEntries(authorities.list().map((a) => [a.audience, a.capability])),
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
    }) : null;

    return {
        enabled,
        /** The bearer token for one authority's audience; throws when Network cannot mint it. */
        get: async (authority) => (client ? client.getToken({ audience: authority.audience }) : null),
        /** What a caller may show without a token: the audiences it can mint for, and whether it can. */
        status: () => ({ enabled, client_id: config.oauth.clientId, audiences: authorities.list().map((a) => a.audience) }),
        invalidate: (ctx) => { if (client) client.invalidate(ctx); },
    };
}

module.exports = { createAuthorityTokens };
