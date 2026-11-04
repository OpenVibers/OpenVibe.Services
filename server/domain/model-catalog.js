'use strict';

/**
 * The model catalog the developer portal shows (AI Exchange P8): every model OpenVibe AI can run, its exact identity
 * (org/model[:quant]@revision), its variant (original, abliterated, fine-tuned, merged, LoRA), what it can do, its retail
 * price, and who supplies it. OpenVibe.AI is the authority (GET /v1/models, ai.model@1); Services only shows it.
 *
 *   createModelCatalog({ config, fetchImpl, now })
 *     list()                      → { source: 'ai' | 'preview', at, models: [ai.model@1 …], aliases: […], problem }
 *     get(id)                     → one model or alias, or null
 *   cost(model, usage)            → BigInt nano-USD for one request (AI Exchange D1: once per component, ceil)
 *   usd(nano, { per })            → "$0.000123" — exact to the nano-dollar, never a float
 *   WORKLOADS, filterModels(models, query), sortModels(models, by, workload)
 *
 * Source: AI's catalog when SERVICES_MODEL_CATALOG_SOURCE=ai (cached a minute, a failure is said and the last
 * reading kept); otherwise the preview fixture (server/data/ai-models.preview.json), whose prices are examples and
 * every page says so. The pages are behind SERVICES_MODEL_EXPLORER (off) until AI's catalog and Billing's
 * inference prices are live: no public price promise before the owner approves one.
 */

const fs = require('fs');
const path = require('path');

const PREVIEW = path.join(__dirname, '..', 'data', 'ai-models.preview.json');
const NANO = 1_000_000_000n;
const COMPONENTS = ['input', 'cached_read', 'cache_write', 'output'];
const VARIANTS = {
    original: 'Original', abliterated: 'Abliterated', finetuned: 'Fine-tuned', merged: 'Merged', lora: 'LoRA',
};
const ACCESS = {
    OWN_DEPLOYMENT: ['OpenVibe-run', 'ok'],
    AUTHORIZED_WHOLESALE: ['Licensed partner', 'ok'],
    CUSTOMER_BYOK: ['Your own key', 'new'],
    RESTRICTED: ['Restricted', 'bad'],
    UNVERIFIED: ['Pending agreement', 'off'],
};
const AVAILABILITY = {
    available: ['Available', 'ok'], planned: ['Planned', 'off'], pending_agreement: ['Pending agreement', 'off'],
    byok_only: ['With your own key', 'new'], degraded: ['Degraded', 'warn'],
};

/** Workloads a price is shown for: tokens of each class in one request. */
const WORKLOADS = {
    chat: { label: 'Chat reply', desc: '1,200 tokens in, 400 out', usage: { input: 1200, cached_read: 0, cache_write: 0, output: 400 } },
    coding: { label: 'Coding step', desc: '6,000 in, 20,000 cached, 1,200 out', usage: { input: 6000, cached_read: 20000, cache_write: 0, output: 1200 } },
    agent: { label: 'Agent turn', desc: '3,000 in, 15,000 cached, 2,000 cache write, 800 out', usage: { input: 3000, cached_read: 15000, cache_write: 2000, output: 800 } },
    document: { label: 'Long document', desc: '30,000 in, 600 out', usage: { input: 30000, cached_read: 0, cache_write: 0, output: 600 } },
};

const big = (v) => {
    if (typeof v === 'bigint') return v;
    const s = String(v == null ? '0' : v).trim();
    return /^[0-9]{1,19}$/.test(s) ? BigInt(s) : 0n;
};
const ceilDiv = (a, b) => (a + b - 1n) / b;

/** One request's retail charge in nano-USD: each token class rounded up once, then the per-request fee. */
function cost(model, usage = {}) {
    const r = (model && model.retail) || {};
    const per = r.nano_usd_per_m || {};
    let total = big(r.per_request_nano_usd);
    for (const c of COMPONENTS) {
        const tokens = BigInt(Math.max(0, Math.floor(Number(usage[c]) || 0)));
        if (tokens === 0n) continue;
        total += ceilDiv(tokens * big(per[c]), 1_000_000n);
    }
    return total;
}

/**
 * Nano-USD as dollars, exactly: "$12.50", "$0.0042", "$0.000123". Whole cents above a dollar; below, enough decimals
 * to show three significant digits, never more than nine (one nano-dollar).
 */
function usd(nano, { per = null } = {}) {
    let n = big(nano);
    if (per) n *= BigInt(per);
    const whole = n / NANO;
    const frac = (n % NANO).toString().padStart(9, '0');
    let digits;
    if (whole >= 1n) digits = 2;
    else {
        const lead = frac.search(/[1-9]/);
        digits = lead < 0 ? 2 : Math.min(9, Math.max(2, lead + 3));
    }
    let shown = frac.slice(0, digits).replace(/0+$/, '');
    if (whole >= 1n || shown.length < 2) shown = frac.slice(0, 2);
    return `$${whole.toLocaleString('en-US')}.${shown}`;
}

/** A per-million rate as dollars per million tokens. */
const perMillion = (nanoPerM) => usd(nanoPerM);

function normalize(m) {
    if (!m || typeof m !== 'object' || !m.id) return null;
    return {
        ...m,
        variant: VARIANTS[m.variant] ? m.variant : (m.dynamic ? null : 'original'),
        capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
        access: Array.isArray(m.access) ? m.access.filter((a) => ACCESS[a]) : [],
        availability: AVAILABILITY[m.availability] ? m.availability : 'planned',
    };
}

function filterModels(models, q = {}) {
    const text = String(q.q || '').trim().toLowerCase();
    const caps = [].concat(q.cap || []).filter(Boolean);
    return models.filter((m) => {
        if (text && !`${m.id} ${m.name} ${m.family || ''} ${m.org || ''}`.toLowerCase().includes(text)) return false;
        if (q.variant && q.variant !== 'all' && m.variant !== q.variant) return false;
        if (caps.some((c) => !m.capabilities.includes(c))) return false;
        if (q.access === 'managed' && !m.access.some((a) => a === 'OWN_DEPLOYMENT' || a === 'AUTHORIZED_WHOLESALE')) return false;
        if (q.access === 'byok' && !m.access.includes('CUSTOMER_BYOK')) return false;
        if (q.context && Number(m.context_tokens || 0) < Number(q.context)) return false;
        return true;
    });
}

function sortModels(models, by = 'price', workload = 'chat') {
    const usage = (WORKLOADS[workload] || WORKLOADS.chat).usage;
    const list = [...models];
    if (by === 'context') list.sort((a, b) => Number(b.context_tokens || 0) - Number(a.context_tokens || 0) || a.name.localeCompare(b.name));
    else if (by === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
    else list.sort((a, b) => { const d = cost(a, usage) - cost(b, usage); return d < 0n ? -1 : d > 0n ? 1 : a.name.localeCompare(b.name); });
    return list;
}

function createModelCatalog({ config = {}, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console } = {}) {
    const source = String(process.env.SERVICES_MODEL_CATALOG_SOURCE || config.modelCatalogSource || 'preview');
    const aiUrl = String(process.env.OV_AI_PUBLIC_URL || config.aiUrl || 'https://ai.openvibe.services').replace(/\/+$/, '');
    let cache = { at: 0, value: null };

    function preview() {
        const doc = JSON.parse(fs.readFileSync(PREVIEW, 'utf8'));
        return { source: 'preview', at: doc.as_of || null, models: (doc.models || []).map(normalize).filter(Boolean), aliases: (doc.aliases || []).map(normalize).filter(Boolean), problem: null };
    }

    async function fromAi() {
        const res = await fetchImpl(`${aiUrl}/v1/models`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`OpenVibe AI answered ${res.status}`);
        const doc = await res.json();
        const all = (doc.data || doc.models || []).map(normalize).filter(Boolean);
        return { source: 'ai', at: new Date(now()).toISOString(), models: all.filter((m) => !m.dynamic), aliases: all.filter((m) => m.dynamic), problem: null };
    }

    async function list() {
        if (source !== 'ai') return preview();
        if (cache.value && now() - cache.at < 60_000) return cache.value;
        try {
            cache = { at: now(), value: await fromAi() };
        } catch (e) {
            log.warn && log.warn(`[Services] the model catalog could not be read: ${String(e && e.message).slice(0, 160)}`);
            const kept = cache.value || { source: 'ai', at: null, models: [], aliases: [] };
            return { ...kept, problem: { code: 'services.ai_catalog_unavailable', detail: 'OpenVibe AI did not answer; the last reading is shown.' } };
        }
        return cache.value;
    }

    async function get(id) {
        const all = await list();
        return [...all.models, ...all.aliases].find((m) => m.id === id) || null;
    }

    return { list, get, source };
}

module.exports = { createModelCatalog, cost, usd, perMillion, filterModels, sortModels, normalize, WORKLOADS, VARIANTS, ACCESS, AVAILABILITY, COMPONENTS };
