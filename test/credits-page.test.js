'use strict';
/**
 * A project's Credits page (AI Exchange D9): the balance, held and available from OpenVibe Billing's /api/me/credits
 * with the person's own token, spend per day, recent requests with exact charges; "not open yet" when Billing's ledger
 * is off; nothing without the explorer's flag.
 */
const assert = require('assert');
const http = require('http');
const { daily } = require('../server/domain/credits');

(async () => {
    const asked = [];
    let mode = 'open';
    const billing = http.createServer((req, res) => {
        asked.push({ url: req.url, auth: req.headers.authorization || '' });
        if (mode === 'off') { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ code: 'billing.not_enabled', detail: 'Credits are not open yet' })); }
        const today = new Date().toISOString();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            project_id: 'x', balance_nano_usd: '4999896', held_nano_usd: '20000', available_nano_usd: '4979896',
            charges: [
                { at: today, settlement_id: 'stl_1', service: 'ai', model: 'qwen/qwen3-4b:q4_k_m@3f2a1c9', charge_nano_usd: '104', shortfall_nano_usd: '0', byok: false, usage: { input_tokens: 1000, cached_read_tokens: 0, cache_write_tokens: 0, output_tokens: 1000 } },
                { at: today, settlement_id: 'stl_2', service: 'ai', model: 'deepseek/deepseek-v3.2@preview', charge_nano_usd: '0', shortfall_nano_usd: '0', byok: true, usage: { input_tokens: 50, cached_read_tokens: 0, cache_write_tokens: 0, output_tokens: 9 } },
            ],
        }));
    });
    await new Promise((r) => billing.listen(0, '127.0.0.1', r));
    process.env.OV_BILLING_INTERNAL_URL = `http://127.0.0.1:${billing.address().port}`;
    const { boot, check, done } = require('./helpers/boot');

    await check('spend per day: the last 30 days, exact', async () => {
        const now = Date.UTC(2026, 10, 3, 12);
        const d = daily([{ at: '2026-11-03T01:00:00Z', charge_nano_usd: '104' }, { at: '2026-11-03T02:00:00Z', charge_nano_usd: '6' }, { at: '2026-10-01T00:00:00Z', charge_nano_usd: '9' }], 30, now);
        assert.strictEqual(d.length, 30);
        assert.strictEqual(d[29].day, '2026-11-03');
        assert.strictEqual(d[29].nano, 110n);
        assert.strictEqual(d.reduce((m, x) => m + x.nano, 0n), 110n, 'a day outside the window is not counted');
    });

    const t = await boot();
    const owner = t.network.addUser('nia');
    const projectId = await t.project(owner, 'Spend');
    try {
        await check('off by default', async () => {
            delete process.env.SERVICES_MODEL_EXPLORER;
            assert.strictEqual((await t.get(`/projects/${projectId}/credits`, { as: owner })).status, 404);
        });
        process.env.SERVICES_MODEL_EXPLORER = '1';
        await check('the page: balance, held, available, the requests, with the person\'s own token', async () => {
            const r = await t.get(`/projects/${projectId}/credits`, { as: owner });
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.match(asked.at(-1).url, new RegExp(`^/api/me/credits\\?project_id=${projectId}$`));
            assert.match(asked.at(-1).auth, /^Bearer ey/, 'the person\'s own token');
            assert.match(r.text, /<span>Balance<\/span><b>\$0\.00499<\/b>/);
            assert.match(r.text, /<span>Held now<\/span><b>\$0\.00002<\/b>/);
            assert.match(r.text, /<code class="mx-id">qwen\/qwen3-4b:q4_k_m@3f2a1c9<\/code>/);
            assert.match(r.text, /\$0\.000000104/);
            assert.match(r.text, /Your key/, 'a BYOK request says so');
            assert.match(r.text, /Top-ups open when Credits launch/);
        });
        await check('start with AI: each step read live, the next one marked, its action offered', async () => {
            const page = async () => (await t.get(`/projects/${projectId}/ai`, { as: owner })).text;
            let h = await page();
            assert.match(h, /0 of 5 done|1 of 5 done/);
            assert.match(h, /class="mx-card ob-step is-next"><span class="ob-n" aria-hidden="true">1<\/span>/, 'first: a sandbox app');
            const app = await t.app(owner, projectId);
            h = await page();
            assert.match(h, /<span class="ob-n" aria-hidden="true">2<\/span>[\s\S]*?Next/, 'then: the permission');
            assert.match(h, new RegExp(`action="/projects/${projectId}/apps/${app.id}/grants"`), 'with the button that asks for it');
            await t.grant(owner, projectId, app.id, 'ai.inference.create');
            h = await page();
            assert.match(h, new RegExp(`href="/projects/${projectId}/apps/${app.id}/playground#ai"`), 'then: the playground');
            assert.match(h, /Balance <b>\$0\.00499<\/b>/, 'and the Credits, read from Billing');
        });

        await check('Billing\'s ledger off: "not open yet", not an error page', async () => {
            mode = 'off';
            const r = await t.get(`/projects/${projectId}/credits`, { as: owner });
            assert.strictEqual(r.status, 200);
            assert.match(r.text, /Credits are not open yet\./);
        });
    } finally {
        delete process.env.SERVICES_MODEL_EXPLORER;
        await t.close();
        billing.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
