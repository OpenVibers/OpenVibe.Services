'use strict';
/**
 * /docs/vibes and /docs/balance (D12): the two money guides are public, crawlable and use the owner's words —
 * Vibes, Balance, Add money, Get Vibes — never "Credits" or "earn Vibes". They link from /docs and name the SDK's
 * Vibes Pay calls, the webhook signature and the Balance transfer. No flag: these are documentation, not a feature.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        await check('the docs index links both guides', async () => {
            const r = await t.get('/docs');
            assert.strictEqual(r.status, 200);
            assert.match(r.text, /href="\/docs\/vibes"/);
            assert.match(r.text, /href="\/docs\/balance"/);
        });

        await check('/docs/vibes: what Vibes are, Vibes Pay, the SDK, plain HTTP, webhooks, sandbox, refunds, payouts, limits', async () => {
            const r = await t.get('/docs/vibes');
            assert.strictEqual(r.status, 200, r.text.slice(0, 200));
            assert.match(r.text, /<title>Vibes and Vibes Pay · OpenVibe\.Services<\/title>/);
            for (const text of ['What Vibes are', 'Vibes Pay step by step', 'Server SDK', 'Plain HTTP', 'Webhooks and their signature',
                'Sandbox', 'Refunds', 'Payouts', 'Limits and errors', 'openvibe-sdk/vibes', 'charges.create', 'webhooks.verify',
                'X-OpenVibe-Signature-V2', 'billing.vibes.charge.paid', 'Get Vibes', 'whole number']) {
                assert.ok(r.text.includes(text), `vibes guide says ${text}`);
            }
            assert.match(r.text, /amount: 50/);
            assert.match(r.text, /idempotency/i);
            assert.match(r.text, /300 seconds/, 'the replay window is stated');
            assert.ok(!/Credits/i.test(r.text), 'never Credits');
            assert.ok(!/\bearn(?:ing|ed)? Vibes\b/i.test(r.text), 'Vibes are bought and spent, never earned');
        });

        await check('/docs/balance: metered usage, Add money, moving money to a project, exact nano-USD', async () => {
            const r = await t.get('/docs/balance');
            assert.strictEqual(r.status, 200, r.text.slice(0, 200));
            assert.match(r.text, /<title>Balance · OpenVibe\.Services<\/title>/);
            for (const text of ['How usage bills a project\'s Balance', 'Add money', 'Move money to a project', 'Move to a project',
                '/api/me/balance', '/api/me/balance/transfers', 'nano-dollar', 'project:&lt;prj_id&gt;', 'Sandbox']) {
                assert.ok(r.text.includes(text), `balance guide says ${text}`);
            }
            assert.match(r.text, /amount_nano_usd/);
            assert.match(r.text, /502|5000000000/, 'an exact nano-USD example');
            assert.ok(!/Credits/i.test(r.text), 'never Credits');
        });

        await check('both guides are crawlable (not noindex)', async () => {
            for (const p of ['/docs/vibes', '/docs/balance']) {
                const r = await t.get(p);
                assert.ok(!/<meta name="robots" content="noindex/i.test(r.text), `${p} is indexable`);
                assert.match(r.text, /<link rel="canonical"/);
            }
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
