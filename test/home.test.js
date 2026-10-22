'use strict';
/**
 * The home page's own sections (server/http/home.js): numbers counted from the pinned contracts and SDK (services up
 * only when Network's status was read), what you can build (each card points at a working example or a reference),
 * quick-start code that runs against the pinned SDK as written, limits in plain units, and a FAQ that its FAQPage
 * JSON-LD repeats word for word.
 */
const assert = require('assert');
const sdk = require('openvibe-sdk');
const home = require('../server/http/home');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    await check('limits read in plain units', async () => {
        assert.strictEqual(home.limitAmount(120, 'per_minute'), '120 a minute');
        assert.strictEqual(home.limitAmount(5242880, 'bytes'), '5 MB');
        assert.strictEqual(home.limitAmount(65536, 'bytes'), '64 KB');
        assert.strictEqual(home.limitAmount(20, 'count'), '20');
        assert.strictEqual(home.limitAmount(1, 'days'), '1 day');
        assert.strictEqual(home.limitAmount(0, 'days'), 'none');
        assert.strictEqual(home.limitAmount(null, 'count'), 'unlimited');
    });

    await check('the quick-start code runs as written against the pinned SDK (a stub platform answers)', async () => {
        const html = home.quickStart({ sdkVersion: '0.60.0' });
        const unesc = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        const samples = [...html.matchAll(/<code class="language-js">([\s\S]*?)<\/code>/g)].map((m) => unesc(m[1]));
        assert.ok(samples.length >= 2, 'two Node samples');
        const seen = [];
        const fetchStub = async (url) => {
            const u = new URL(String(url));
            seen.push(u.pathname);
            const body = u.pathname === '/.well-known/openvibe' ? { name: 'OpenVibe', issuer: 'https://openvibe.network', contracts: { version: require('openvibe-contracts/package.json').version }, services: [{ id: 'search', origin: 'https://search.openvibe.network' }, { id: 'network', origin: 'https://openvibe.network' }] }
                : u.pathname === '/api/v1/search' ? { results: [{ title: 'Patch notes' }], next_cursor: null }
                : u.pathname === '/api/v1/registry/services' ? { services: [{ id: 'live' }] }
                    : { ok: true };
            return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
        };
        const realFetch = globalThis.fetch;
        globalThis.fetch = fetchStub;
        try {
            // The first sample is the one that needs no key: run it whole.
            const run = new Function('require', `return (async () => { ${samples[0]}\n return { results, services }; })();`);
            const out = await run((id) => require(id));
            assert.deepStrictEqual(out.results.map((r) => r.title), ['Patch notes']);
            assert.deepStrictEqual(out.services.map((s) => s.id), ['live']);
            assert.ok(seen.includes('/api/v1/search') && seen.includes('/api/v1/registry/services'), `it called search and the registry: ${seen}`);
        } finally { globalThis.fetch = realFetch; }
        // The app sample names only functions the pinned SDK has.
        assert.strictEqual(typeof sdk.auth.createServiceTokenClient, 'function');
        assert.strictEqual(typeof sdk.auth.createServiceTokenClient({ clientId: 'a', clientSecret: 'b' }).getTokenInfo, 'function');
        assert.strictEqual(typeof sdk.media.createMediaClient(sdk.createClient(), { app: 'prj_1' }).upload, 'function');
        assert.match(html, /codeload\.github\.com\/OpenVibers\/OpenVibe\.SDK\/tar\.gz\/refs\/tags\/v0\.60\.0/, 'the install line names the pinned tag');
        assert.match(html, /https:\/\/openvibe\.network\/oauth\/token/, 'the curl sample uses Network\'s token endpoint');
    });

    const t = await boot();
    try {
        await check('the home page: hero code that runs, numbers, what you can build, quick start, FAQ and its JSON-LD', async () => {
            let r = await t.get('/');
            assert.strictEqual(r.status, 200);
            assert.ok(!/ov\.registry\./.test(r.text), 'the hero code no longer calls a client property the SDK does not have');
            assert.match(r.text, /sdk\.registry\.createRegistryClient\(ov\)/);
            assert.match(r.text, /<b>\d+<\/b><span>capabilities an app can request<\/span>/);
            assert.match(r.text, /<b>\d+<\/b><span>event types to subscribe to<\/span>/);
            assert.ok(!/services up now/.test(r.text), 'no services-up number while Network\'s status was not read');
            for (const name of ['oauth-app', 'media-uploader', 'webhook-consumer', 'tool-job', 'chat-bot']) {
                assert.ok(r.text.includes(`href="https://github.com/OpenVibers/OpenVibe.Examples/tree/main/examples/${name}"`), `links the ${name} example`);
            }
            assert.match(r.text, /id="quick-start"/);
            assert.match(r.text, /\d+ capabilit(y|ies)( · \d+ event types?)?<\/small>/, 'each service says what an app can be granted');
            assert.ok(!/per_minute|\d bytes</.test(r.text), 'limits read in plain units');
            const blocks = [...r.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
            const faq = blocks.find((b) => b['@type'] === 'FAQPage');
            assert.ok(faq && faq.mainEntity.length === home.FAQ.length, 'a FAQPage node with every question');
            faq.mainEntity.forEach((q) => assert.ok(r.text.includes(`<h3>${q.name.replace(/'/g, '&#39;')}</h3>`), `the page shows "${q.name}"`));
            assert.strictEqual((r.text.match(/<h1[\s>]/g) || []).length, 1, 'one h1');

            t.ctx.networkStatus = { peek: () => ({ up: 37, checked: 38 }) };
            r = await t.get('/');
            assert.match(r.text, /<b>37<\/b><span>services up now, of 38 checked<\/span>/, 'services up once Network answered');
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
