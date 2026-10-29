'use strict';
/**
 * The home page's own sections (server/http/home.js): numbers counted from the pinned contracts and SDK (services up
 * only when Network's status was read) as one strip, the building blocks as a launcher with every service's API behind
 * See all, the working examples, hero code that runs against the pinned SDK as written, limits in plain units, and a
 * FAQ that its FAQPage JSON-LD repeats word for word. A front page is a taste and a door: two hero actions, and what is
 * read once (more code, the limits) folded.
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

    await check('the hero and quick-start code run as written against the pinned SDK (a stub platform answers)', async () => {
        const html = home.quickStart({ sdkVersion: '0.60.0' });
        const unesc = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        const samples = [home.heroCode({ sdkVersion: '0.60.0' }), ...[...html.matchAll(/<code class="language-js">([\s\S]*?)<\/code>/g)].map((m) => unesc(m[1]))];
        assert.ok(samples.length >= 2, 'the hero\'s sample and the app\'s');
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
            // The hero's sample is the one that needs no key: run it whole.
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
        await check('the home page: hero code that runs, the numbers strip, the building blocks launcher, examples, folded code, FAQ and its JSON-LD', async () => {
            let r = await t.get('/');
            assert.strictEqual(r.status, 200);
            assert.ok(!/ov\.registry\./.test(r.text), 'the hero code no longer calls a client property the SDK does not have');
            assert.match(r.text, /sdk\.registry\.createRegistryClient\(ov\)/);
            assert.strictEqual((/<section class="sc-hero[\s\S]*?<\/section>/.exec(r.text)[0].match(/class="sc-btn/g) || []).length, 2, 'two hero actions');
            // The numbers are one kit.stats strip, each opening the reference it counts.
            assert.match(r.text, /<dl class="ovk-stats" aria-label="The platform in numbers">/);
            assert.match(r.text, /<dt><a href="\/docs\/capabilities\?grantable=1">capabilities an app can request<\/a><\/dt><dd>\d+<\/dd>/);
            assert.match(r.text, /<dt><a href="\/docs\/events">event types to subscribe to<\/a><\/dt><dd>\d+<\/dd>/);
            assert.ok(!/services up now/.test(r.text), 'no services-up number while Network\'s status was not read');
            for (const name of ['oauth-app', 'media-uploader', 'webhook-consumer', 'tool-job', 'chat-bot']) {
                assert.ok(r.text.includes(`href="https://github.com/OpenVibers/OpenVibe.Examples/tree/main/examples/${name}"`), `links the ${name} example`);
            }
            assert.match(r.text, /id="quick-start"/);
            // Read once, so folded: a new app from a template, and an app's calls past the hero's code.
            assert.match(r.text, /<details class="ovk-fold" id="qs-template">[\s\S]*?create-openvibe-app[\s\S]*?<\/details>/);
            assert.match(r.text, /<details class="ovk-fold" id="qs-app">[\s\S]*?createServiceTokenClient[\s\S]*?oauth\/token[\s\S]*?<\/details>/);
            // The building blocks as a launcher (showcase.apps), each linked; every service's API behind See all; people
            // who only want to use OpenVibe go to Vibe.
            const launcher = (/<section class="sc-sec sc-apps-sec" id="blocks"[\s\S]*?<\/section>/.exec(r.text) || [''])[0];
            assert.ok(launcher.includes('<ul class="sc-apps">'), 'the building blocks are a launcher');
            for (const b of home.BLOCKS) assert.ok(launcher.includes(`<a href="${b.href}">`) && launcher.includes(`<b>${b.name}</b>`), `the ${b.name} block`);
            const apis = require('openvibe-contracts').openapi.index().length;
            assert.ok(launcher.includes(`<p class="sc-apps-more"><a href="/docs/api">See all ${apis} service APIs →</a></p>`), 'See all opens every service\'s API reference');
            assert.ok(launcher.includes('<a href="https://openvibe.chat/vibe">Chat with Vibe</a>'), 'people are sent to Vibe');
            assert.ok(!/per_minute|\d bytes</.test(r.text), 'limits read in plain units');
            assert.ok(/\/shared\/kit\.css\?v=/.test(r.text) && !/\/shared\/kit-web\.js/.test(r.text) && !/kit-data/.test(r.text), 'kit.css for the strip, folds and list; no kit-web.js or Kit 2');
            assert.ok(!/class="svc-faq"|<h3 class="home-/.test(r.text), 'no hand-built FAQ or section markup is left');
            const blocks = [...r.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
            const faq = blocks.find((b) => b['@type'] === 'FAQPage');
            assert.ok(faq && faq.mainEntity.length === home.FAQ.length, 'a FAQPage node with every question');
            faq.mainEntity.forEach((q) => assert.ok(r.text.includes(`<summary>${q.name.replace(/'/g, '&#39;')}</summary>`), `the page shows "${q.name}"`));
            assert.strictEqual((r.text.match(/<h1[\s>]/g) || []).length, 1, 'one h1');
            assert.strictEqual((r.text.match(/<section[\s>]/g) || []).length, (r.text.match(/<\/section>/g) || []).length, 'every section is closed once');

            t.ctx.networkStatus = { peek: () => ({ up: 37, checked: 38 }) };
            // What a project gets, from the service that enforces it, folded with its source.
            t.ctx.limits = { bySource: (s) => (s === 'events' ? { service: 'events', public: 'https://openvibe.events/limits.json' } : null), read: async () => ({ body: { limits: [{ label: 'Events published per minute', sandbox: 30, production: 120, unit: 'per_minute' }] } }) };
            r = await t.get('/');
            assert.match(r.text, /<dt><a href="https:\/\/openvibe\.network\/status">services up now, of 38 checked<\/a><\/dt><dd>37<\/dd>/, 'services up once Network answered');
            assert.match(r.text, /<details class="ovk-fold" id="limits">[\s\S]*?<td>30 a minute<\/td><td>120 a minute<\/td>[\s\S]*?openvibe\.events\/limits\.json[\s\S]*?<\/details>/, 'the limits, folded, in plain units with their source');
            assert.strictEqual((r.text.match(/<section[\s>]/g) || []).length, (r.text.match(/<\/section>/g) || []).length, 'the folded limits leave no section open');
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
