'use strict';

/**
 * Network's confirmations, service side (roadmap WS-Z2; OpenVibe.Network server/developer/confirmations.js, its
 * /internal/confirmations router behind network.confirmation.manage). Services owns services.resource.control, so it is
 * the service that asks an agent's owner to approve one sensitive control request and then spends that approval once:
 *
 *   create({ agentId, summary, details, requestDigest })  POST /internal/confirmations → network.confirmation-request@1
 *                                                          (pending: the owner is asked; approved: a standing rule said yes)
 *   consume(id, requestDigest)                             POST /internal/confirmations/:id/consume → spends the approval;
 *                                                          Network re-checks it is approved, unused, unexpired and for
 *                                                          this exact request (the digest)
 *
 * Network mints the confirmation id, derives the owner from the agent and keeps the decision; Services never mints or
 * approves one. The token is Services' own client-credentials token for audience openvibe.network, scoped to
 * network.confirmation.manage. Network's refusal comes back as { ok: false, status, code, detail } so the caller can put it
 * in a result; a transport or token failure is 503 confirmations.unavailable.
 */
const NETWORK = Object.freeze({ id: 'network', audience: 'openvibe.network' });
const CAP = 'network.confirmation.manage';
const CONTROL_CAP = 'services.resource.control';

const trim = (u) => String(u || '').replace(/\/+$/, '');

function createConfirmations(config, { tokens, fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
    const base = `${trim(config.network.internalUrl)}/internal/confirmations`;

    async function call(path, body) {
        let res;
        try {
            const token = await tokens.get(NETWORK, CAP);
            res = await fetchImpl(`${base}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (err) {
            return { ok: false, status: 503, code: 'confirmations.unavailable', detail: `OpenVibe.Network's confirmations did not answer (${err.message})` };
        }
        const data = await res.json().catch(() => null);
        if (res.ok && data && data.confirmation) return { ok: true, confirmation: data.confirmation };
        if (res.status >= 500 || res.status === 401 || !data || typeof data.code !== 'string') {
            return { ok: false, status: 503, code: 'confirmations.unavailable', detail: `OpenVibe.Network's confirmations answered HTTP ${res.status}` };
        }
        return { ok: false, status: res.status, code: data.code, detail: data.detail || data.title || data.code };
    }

    return {
        create: ({ agentId, summary, details, requestDigest }) => call('', {
            requested_by: { type: 'agent', id: agentId }, capability: CONTROL_CAP, summary, details, request_digest: requestDigest,
        }),
        consume: (id, requestDigest) => call(`/${encodeURIComponent(id)}/consume`, { request_digest: requestDigest }),
    };
}

module.exports = { createConfirmations, NETWORK, CAP };
