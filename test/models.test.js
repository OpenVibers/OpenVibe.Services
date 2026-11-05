'use strict';
/**
 * The model explorer (AI Exchange P8): the nano-dollar arithmetic (CHECKPOINT D1), the catalog's filters and order,
 * and the pages (/models, /models/compare, /models/:id) behind SERVICES_MODEL_EXPLORER, on the preview fixture.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const lib = require('../server/domain/model-catalog');

(async () => {
    await check('the arithmetic: once per token class, rounded up, in nano-dollars', async () => {
        const m = { retail: { nano_usd_per_m: { input: '20000000', cached_read: '5000000', cache_write: '20000000', output: '60000000' }, per_request_nano_usd: '0' } };
        // 1,200 input at $0.02/M = 24,000 nano; 400 output at $0.06/M = 24,000 nano.
        assert.strictEqual(lib.cost(m, { input: 1200, output: 400 }), 48000n);
        // One token at $0.02/M is 20 nano-dollars: exact, nothing rounded.
        assert.strictEqual(lib.cost(m, { input: 1 }), 20n);
        assert.strictEqual(lib.cost(m, { input: 1, cached_read: 1, cache_write: 1, output: 1 }), 105n, 'four classes added exactly');
        // 1,000 tokens at 333 nano per million is 0.333 nano: rounded up once, to 1 nano, not to a cent and not per row.
        const tiny = { retail: { nano_usd_per_m: { input: '333', cached_read: '333', cache_write: '333', output: '333' } } };
        assert.strictEqual(lib.cost(tiny, { input: 1000 }), 1n);
        assert.strictEqual(lib.cost(tiny, { input: 1000, cached_read: 1000, cache_write: 1000, output: 1000 }), 4n, 'each class rounded once');
        assert.strictEqual(lib.cost(tiny, { input: 4000 }), 2n, 'one class, one rounding (1.332 → 2), never per token');
        assert.strictEqual(lib.cost({ retail: { nano_usd_per_m: {}, per_request_nano_usd: '1500' } }, {}), 1500n);
        assert.strictEqual(lib.usd(48000n), '$0.000048');
        assert.strictEqual(lib.usd(4200000n), '$0.0042');
        assert.strictEqual(lib.usd(20000000n), '$0.02');
        assert.strictEqual(lib.usd(12500000000n), '$12.50');
        assert.strictEqual(lib.usd(0n), '$0.00');
        assert.strictEqual(lib.usd(1n), '$0.000000001');
        assert.strictEqual(lib.usd(48000n, { per: 1000000 }), '$48.00');
        assert.strictEqual(lib.usd('not money'), '$0.00', 'a malformed amount is nothing, never NaN');
    });

    await check('the catalog: filters and order', async () => {
        const cat = lib.createModelCatalog({ config: {} });
        const { models, aliases, source } = await cat.list();
        assert.strictEqual(source, 'preview');
        assert.ok(models.length >= 5 && aliases.every((a) => a.dynamic && a.id.startsWith('openvibe/')));
        assert.ok(models.every((m) => /^[a-z0-9-]+\/[a-z0-9.-]+(:[a-z0-9_]+)?@[a-z0-9]+$/.test(m.id)), 'every id is exact (D3)');
        const contracts = require('openvibe-contracts');
        const raw = require('../server/fixtures/ai-models.preview.json').models;
        for (const m of raw) { const v = contracts.validate('ai.model@1', m); assert.ok(v.valid, `${m.id}: ${JSON.stringify(v.errors).slice(0, 300)}`); }
        assert.ok(models.every((m) => m.retail && m.retail.nano_usd_per_m && m.capabilities.length), 'normalized from the contract shape');
        assert.ok(lib.filterModels(models, { variant: 'abliterated' }).every((m) => m.variant === 'abliterated'));
        assert.ok(lib.filterModels(models, { cap: ['vision'] }).every((m) => m.capabilities.includes('vision')));
        assert.ok(lib.filterModels(models, { access: 'managed' }).every((m) => m.access.some((a) => a === 'OWN_DEPLOYMENT' || a === 'AUTHORIZED_WHOLESALE')));
        const sorted = lib.sortModels(models, 'price', 'chat');
        for (let i = 1; i < sorted.length; i++) assert.ok(lib.cost(sorted[i - 1], lib.WORKLOADS.chat.usage) <= lib.cost(sorted[i], lib.WORKLOADS.chat.usage));
    });

    const t = await boot();
    try {
        await check('off by default: no page, no price promised', async () => {
            assert.strictEqual((await t.get('/models')).status, 404);
        });

        // The owner changes services.ai from the AI tab: the running process reads the store, live.
        await t.ctx.aiConfig.store.apply({ model_explorer: true }, { actor: { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' }, reason: 'test: open the explorer' });
        await check('the list: every model, a preview label, the aliases, filters that work without script', async () => {
            const res = await t.get('/models');
            assert.strictEqual(res.status, 200, res.text.slice(0, 300));
            assert.match(res.text, /<b>Preview\.<\/b>/, 'example prices are said to be examples');
            assert.match(res.text, /noindex/, 'never indexed');
            assert.match(res.text, /<code>openvibe\/auto<\/code>/);
            assert.match(res.text, /css\/models\.css/);
            assert.match(res.text, /js\/models\.js/);
            const ab = await t.get('/models?variant=abliterated&cap=tools');
            assert.match(ab.text, /Qwen3 4B Abliterated/);
            assert.doesNotMatch(ab.text, />Gemma 3 27B Abliterated</, 'no tools: filtered out');
            assert.doesNotMatch(ab.text, />Qwen3 4B<\/a>/, 'the original is not an abliterated variant');
        });

        await check('a model: exact id, price, the calculator from the query, how to call it', async () => {
            const id = 'qwen/qwen3-4b-abliterated:q4_k_m@preview';
            const res = await t.get(`/models/${encodeURIComponent(id)}?input=1200&output=400`);
            assert.strictEqual(res.status, 200, res.text.slice(0, 300));
            assert.match(res.text, /<code class="mx-id is-big" id="mx-the-id">qwen\/qwen3-4b-abliterated:q4_k_m@preview<\/code>/);
            assert.match(res.text, /<b data-mx-one>\$0\.000048<\/b> per request/);
            assert.match(res.text, /never swapped for another quantization or variant/);
            assert.match(res.text, /Not benchmarked yet/);
            assert.match(res.text, /&quot;model&quot;: &quot;qwen\/qwen3-4b-abliterated:q4_k_m@preview&quot;/, 'the curl sample names the exact id');
            assert.strictEqual((await t.get('/models/nope%2Fnothing%40x')).status, 404);
            const alias = await t.get(`/models/${encodeURIComponent('openvibe/economy')}`);
            assert.match(alias.text, /Policy <b>cheapest<\/b>/);
        });

        await check('the guide: start, ids against names, the disclosure, prices worked out exactly, errors', async () => {
            const res = await t.get('/docs/ai');
            assert.strictEqual(res.status, 200);
            assert.match(res.text, /noindex/);
            assert.match(res.text, /never swapped for another quantization/);
            assert.match(res.text, /<code>openvibe\/private<\/code>/);
            assert.match(res.text, /<code>resolved_model<\/code>/);
            // 1,200 x $0.04/M + 8,000 x $0.01/M + 400 x $0.12/M = 48,000 + 80,000 + 48,000 nano = $0.000176.
            assert.match(res.text, /costs <b>\$0\.000176<\/b>/);
            assert.match(res.text, /<code>ai\.model_unavailable<\/code>/);
            await t.ctx.aiConfig.store.apply({ model_explorer: false }, { actor: { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' }, reason: 'test: close it' });
            assert.strictEqual((await t.get('/docs/ai')).status, 404, 'off: no guide either');
            await t.ctx.aiConfig.store.apply({ model_explorer: true }, { actor: { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' }, reason: 'test: open it again' });
        });

        await check('compare: two to four, the cheapest marked per workload', async () => {
            const a = 'qwen/qwen3-4b-abliterated:q4_k_m@preview';
            const b = 'google/gemma-3-27b-abliterated:q4_k_m@preview';
            const res = await t.get(`/models/compare?ids=${encodeURIComponent(a)}&ids=${encodeURIComponent(b)}`);
            assert.strictEqual(res.status, 200);
            assert.match(res.text, /class="mx-bar-row is-best"><span class="mx-bar-name">Qwen3 4B Abliterated/);
            assert.match(res.text, /Not benchmarked yet/);
            const one = await t.get(`/models/compare?ids=${encodeURIComponent(a)}`);
            assert.match(one.text, /Pick two to four models/);
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
