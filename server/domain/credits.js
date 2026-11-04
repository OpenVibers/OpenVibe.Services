'use strict';

/**
 * A project's Credits (AI Exchange D9) as Services shows them: OpenVibe.Billing is the authority (GET /api/me/credits,
 * the person's own token); Services only reads and draws. Nothing is stored here.
 *
 *   createCreditsReader({ config, fetchImpl })
 *     statement(token, projectId) → { project_id, balance_nano_usd, held_nano_usd, available_nano_usd, charges[] }
 *   daily(charges, days, now) → [{ day, nano }] (the last `days` days, oldest first; BigInt nano-USD)
 */

const BILLING = () => String(process.env.OV_BILLING_INTERNAL_URL || 'http://127.0.0.1:4600').replace(/\/+$/, '');

function createCreditsReader({ fetchImpl = globalThis.fetch } = {}) {
    async function statement(token, projectId) {
        const res = await fetchImpl(`${BILLING()}/api/me/credits?project_id=${encodeURIComponent(projectId)}`, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(5000),
        });
        const doc = await res.json().catch(() => null);
        if (!res.ok || !doc) {
            const err = new Error((doc && doc.detail) || `OpenVibe Billing answered ${res.status}`);
            err.status = res.status; err.code = (doc && doc.code) || 'services.billing_unavailable';
            throw err;
        }
        return doc;
    }
    return { statement };
}

/** Spend per UTC day for the last `days` days, oldest first. */
function daily(charges, days = 30, now = Date.now()) {
    const out = [];
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    for (let i = days - 1; i >= 0; i--) out.push({ day: new Date(start.getTime() - i * 86400000).toISOString().slice(0, 10), nano: 0n });
    const by = new Map(out.map((d) => [d.day, d]));
    for (const c of charges || []) {
        const d = by.get(String(c.at || '').slice(0, 10));
        if (d && /^[0-9]{1,19}$/.test(String(c.charge_nano_usd))) d.nano += BigInt(c.charge_nano_usd);
    }
    return out;
}

module.exports = { createCreditsReader, daily };
