'use strict';

/**
 * Services' side of OpenVibe.Network: the signing key every incoming token is verified against, and the
 * project-membership question the person-facing index path asks.
 *
 *   createKeyProvider(config)   Network's RS256 public key: OV_NETWORK_PUBLIC_KEY when the operator pins
 *                               it, else the JWKS (GET {internalUrl}/api/.well-known/jwks) refreshed at boot
 *                               and every six hours; a JWKS outage keeps the last key and never stops the
 *                               process.
 *   createUserAuth(config, keys)  offline verification of a person's Network user token (openvibe-sdk/auth:
 *                               RS256, issuer, expiry; a realtime/stream ticket is never a session).
 *   projectMember(config, token, project)  does the person this token belongs to own or belong to
 *                               `project`? Asked of Network's developer projects API
 *                               (GET /api/v1/projects/:project, viewer+) with the caller's OWN token —
 *                               Services never holds a project's membership itself (ADR-048: Network owns
 *                               projects; Services only shows and calls it).
 */
const crypto = require('crypto');
const { verifyUserToken } = require('openvibe-sdk/auth');

/** Network's RS256 public key: OV_NETWORK_PUBLIC_KEY when the operator pins it, else the JWKS at boot. */
function createKeyProvider(config, { fetchImpl = globalThis.fetch, log = console } = {}) {
    let pem = config.network.publicKey ? crypto.createPublicKey(config.network.publicKey).export({ type: 'spki', format: 'pem' }) : null;
    let timer = null;
    async function load() {
        const url = `${config.network.internalUrl}/api/.well-known/jwks`;
        try {
            const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
            if (!res.ok) throw new Error(`JWKS ${res.status}`);
            const body = await res.json();
            const jwk = (body.keys || []).find((k) => k.kty === 'RSA');
            if (jwk) pem = crypto.createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
            else if (typeof body.public_key === 'string') pem = crypto.createPublicKey(body.public_key).export({ type: 'spki', format: 'pem' });
            else throw new Error('JWKS contained no keys');
            return pem;
        } catch (e) {
            log.warn(`[Services] Network key not loaded from ${url}: ${e.message}`);
            return null;
        }
    }
    function start() {
        if (config.network.publicKey || timer) return;
        const retry = () => load().then((k) => { if (!k) setTimeout(retry, 30_000).unref(); });
        retry();
        timer = setInterval(async () => { await load(); }, 6 * 60 * 60 * 1000);
        timer.unref();
    }
    function stop() { if (timer) clearInterval(timer); timer = null; }
    return { get: () => pem, load, start, stop };
}

/**
 * Offline verification of a Network user token (openvibe-sdk/auth: RS256, issuer, expiry, and a typed
 * token — a realtime or stream ticket — is never a session). Returns the claims, or null.
 */
function createUserAuth(config, keys) {
    async function verify(token) {
        if (!token) return null;
        const publicKey = keys.get();
        if (!publicKey) return null;
        try {
            const claims = await verifyUserToken(token, { publicKey, issuer: config.network.issuer });
            return claims && typeof claims === 'object' ? claims : null;
        } catch { return null; }
    }
    return { verify };
}

/**
 * Does the person who presented `token` own or belong to `project`?
 * Network's developer projects API answers 200 to a viewer-or-higher member and 404 to everyone else
 * (existence is not disclosed), so this returns 'yes' | 'no' | 'unavailable' and the caller answers 404
 * or 503 — never a 403 that would confirm the project exists.
 */
function createMembership(config, { fetchImpl = globalThis.fetch } = {}) {
    async function projectMember(token, projectId) {
        const url = `${config.network.url}/api/v1/projects/${encodeURIComponent(projectId)}`;
        let res;
        try {
            res = await fetchImpl(url, {
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
                signal: AbortSignal.timeout(config.index.networkTimeoutMs),
            });
        } catch {
            return 'unavailable';
        }
        try { await res.body?.cancel(); } catch { /* not needed */ }
        if (res.status === 200) return 'yes';
        if (res.status === 404) return 'no';
        // 401/403 from Network means this token is not a Network session (or is revoked): it is not a
        // member of anything Services can vouch for. 5xx and 429 are Network being unable to answer.
        if (res.status === 401 || res.status === 403) return 'no';
        return 'unavailable';
    }
    return { projectMember };
}

module.exports = { createKeyProvider, createUserAuth, createMembership };
