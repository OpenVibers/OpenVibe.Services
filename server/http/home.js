'use strict';
/**
 * The home page's content beyond the kit's generic sections: the platform in numbers, what people build on it (each
 * card is a working example in OpenVibe.Examples or a generated reference page), quick-start code checked against the
 * pinned SDK, and the questions developers ask. Every number is counted from the pinned contracts or read from
 * OpenVibe.Network's public status within the last minute; nothing here is typed in as a figure.
 */
const contracts = require('openvibe-contracts');
const showcase = require('openvibe-shared/showcase');

const esc = showcase.esc;
const EXAMPLES = 'https://github.com/OpenVibers/OpenVibe.Examples';
const example = (name) => `${EXAMPLES}/tree/main/examples/${name}`;

// ── Services up: Network's public status (GET /api/v1/status, the registry's health poll), read in the background at
// most once a minute and never awaited by a page. A count is shown only when at least half the live services were
// checked; otherwise the number is left out.
function createNetworkStatus({ url, enabled = true, fetchImpl = globalThis.fetch, ttlMs = 60_000, timeoutMs = 2000 } = {}) {
    let value = null;
    let at = 0;
    let inflight = null;
    async function refresh() {
        if (inflight) return inflight;
        inflight = (async () => {
            try {
                const res = await fetchImpl(`${String(url).replace(/\/+$/, '')}/api/v1/status`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
                if (!res.ok) return value;
                const body = await res.json();
                const live = (Array.isArray(body.services) ? body.services : []).filter((s) => s && s.exposure && s.exposure.state === 'live');
                const known = live.filter((s) => s.status && s.status !== 'unknown');
                value = known.length && known.length * 2 >= live.length ? { up: known.filter((s) => s.status === 'up').length, checked: known.length } : null;
            } catch { /* keep the last answer */ }
            at = Date.now();
            return value;
        })().finally(() => { inflight = null; });
        return inflight;
    }
    return {
        peek() { if (enabled && Date.now() - at > ttlMs && !inflight) refresh().catch(() => {}); return value; },   // floating-ok: refresh catches its own errors
        refresh,
        /** Tests. */
        _set(v) { value = v; at = Date.now(); },
    };
}

const publicCaps = (m) => (m.capabilities || []).filter((c) => { const cap = contracts.capabilities.get(c); return cap && cap.status === 'active' && cap.visibility === 'public'; });

/** The platform in numbers: counted from the pinned contracts and SDK, plus services up when Network answered. */
function numbers({ docs, programmable, status }) {
    const items = [
        [programmable.length, 'services you can call', `/docs/services`],
        [docs.capabilities.filter((c) => c.grantable && c.visibility === 'public').length, 'capabilities an app can request', '/docs/capabilities?grantable=1'],
        [docs.events.length, 'event types to subscribe to', '/docs/events'],
        [docs.sdk.length, 'SDK modules, typed', '/docs/sdk'],
        status ? [status.up, `services up now, of ${status.checked} checked`, 'https://openvibe.network/status'] : null,
    ].filter((x) => x && Number(x[0]) > 0);
    return `<section class="sc-sec svc-num" aria-label="The platform in numbers"><ul>${items.map(([n, label, href]) => `<li><a href="${esc(href)}"><b>${esc(Number(n).toLocaleString('en-US'))}</b><span>${esc(label)}</span></a></li>`).join('')}</ul></section>`;
}

// What people build: one card per thing an app can do today, each pointing at code that does it. Text only, like
// the services list: nine inline ring icons would add a quarter to the page's weight.
const BUILD = [
    { title: 'Sign people in with OpenVibe', text: 'OAuth 2.0 with PKCE: a public web app needs no secret, a server app verifies tokens offline. Example: oauth-app and browser-app.', href: example('oauth-app') },
    { title: 'Store and serve files', text: 'Upload into your project\'s own Media space; sandbox files come back with signed, expiring links. Example: media-uploader.', href: example('media-uploader') },
    { title: 'React to what happens', text: 'Publish to your project\'s topic, pull with a durable cursor, or take signed webhooks. Example: event-subscriber and webhook-consumer.', href: example('webhook-consumer') },
    { title: 'Run tools as jobs', text: 'Submit an OpenVibe.Tools job once and follow its stream across restarts. Example: tool-job.', href: example('tool-job') },
    { title: 'Build a chat bot', text: 'A bot that stays in its one room and always says it is a bot. Example: chat-bot.', href: example('chat-bot') },
    { title: 'Search the network', text: 'Streams, recordings, pastes, posts, jobs and help answers from across the network in one query. Public results need no key.', href: '/docs/api/search' },
    { title: 'Call many AI models', text: 'Chat, summaries, extraction and embeddings through one API; every run says which model answered and what it cost.', href: 'https://ai.openvibe.services/' },
    { title: 'Keep objects in S3 buckets', text: 'Private storage zones that the AWS SDKs, rclone and backup tools reach over S3, with keys scoped to a zone.', href: 'https://openvibe.zone/' },
    { title: 'Run jobs on a node', text: 'Send a job to one API; it runs on a node that offers its runtime, including your own computer, and streams its output.', href: 'https://openvibe.run/' },
];

function build() {
    return showcase.features({
        id: 'build', title: 'What you can build today',
        lede: 'Each card is a working example in OpenVibe.Examples (MIT, with a smoke test) or a service you can call now.',
        items: BUILD,
    }).replace(/<\/section>$/, () => `<p class="sc-note">Start from one: <code>npx --package=https://codeload.github.com/OpenVibers/OpenVibe.Examples/tar.gz/refs/tags/v0.3.0 create-openvibe-app my-app --template web</code> (templates: web, server, bot, mod). <a href="${EXAMPLES}">All examples</a>.</p></section>`);
}

/** Quick start: code that runs against production with the pinned SDK (the first sample needs no key at all). */
function quickStart({ sdkVersion }) {
    const install = `npm i https://codeload.github.com/OpenVibers/OpenVibe.SDK/tar.gz/refs/tags/v${sdkVersion}`;
    return showcase.code({
        id: 'quick-start', title: 'Quick start',
        lede: `openvibe-sdk v${sdkVersion}, for Node and the browser. Public reads need no key; an app's calls use the client id and secret of a sandbox app in your project.`,
        samples: [
            { label: 'No key: search the network and list its services', lang: 'js', code: `// ${install}
const sdk = require('openvibe-sdk');
const ov = sdk.createClient();                  // public reads need no token

const search = sdk.search.createSearchClient(ov);
const { results } = await search.query('patch notes', { owner: 'blog' });

const registry = sdk.registry.createRegistryClient(ov);
const services = await registry.services();     // every service, with its health` },
            { label: 'With an app: upload a file to your project', lang: 'js', code: `const sdk = require('openvibe-sdk');
const tokens = sdk.auth.createServiceTokenClient({
    clientId: process.env.OV_CLIENT_ID, clientSecret: process.env.OV_CLIENT_SECRET,
});
const ov = sdk.createClient({ tokenProvider: tokens });
const { unverifiedClaims } = await tokens.getTokenInfo({ audience: 'openvibe.media' });
const media = sdk.media.createMediaClient(ov, { app: unverifiedClaims.project_id });
const file = await media.upload(bytes, { filename: 'logo.png', contentType: 'image/png' });` },
            { label: 'Any language: an app token over HTTP', lang: 'bash', code: `curl -s https://openvibe.network/oauth/token \\
  -d grant_type=client_credentials \\
  -d client_id="$OV_CLIENT_ID" -d client_secret="$OV_CLIENT_SECRET" \\
  -d audience=openvibe.media
# → {"access_token":"…","token_type":"Bearer","expires_in":300,…}` },
        ],
    });
}

// The questions developers ask, answered from what the platform does today. The FAQPage JSON-LD repeats them.
const FAQ = [
    { q: 'What does it cost?', a: 'Nothing today. There is no plan to buy and no card to add; a project gets the limits on this page, which the services themselves enforce.' },
    { q: 'Do I need permission to start?', a: 'No. Sign in, create a project and add a sandbox app; its sandbox capabilities are approved at once. Production is switched on by staff for a project that needs it.' },
    { q: 'Which languages can I use?', a: 'Any that speaks HTTP: every API takes a Bearer token and answers JSON, with RFC 9457 problems for errors. openvibe-sdk adds typed clients for Node and the browser.' },
    { q: 'Where do my client secrets live?', a: 'OpenVibe.Network shows a new secret once and keeps only a hash. This console passes it through in that one response and stores no copy.' },
    { q: 'Can my users sign in with their OpenVibe account?', a: 'Yes. Authorization code with PKCE gives your app a token that acts for the person, carrying only the capabilities your app was granted. A public web app needs no secret.' },
    { q: 'Is it open source?', a: 'Yes. Every OpenVibe service is open source on GitHub under OpenVibers, and the examples are MIT, so you can copy them into your own project.' },
];

function faq() {
    return `<section class="sc-sec" id="faq" aria-labelledby="h-faq"><h2 id="h-faq">Questions developers ask</h2><div class="svc-faq">${FAQ.map((p) => `<div><h3>${esc(p.q)}</h3><p>${esc(p.a)}</p></div>`).join('')}</div></section>`;
}

/** "120 per_minute" → "120 a minute", bytes → KB/MB, a bare count → the number. */
function limitAmount(v, unit) {
    if (v === null || v === undefined) return 'unlimited';
    if (v === 0) return 'none';
    const n = Number(v);
    const fmt = (x) => x.toLocaleString('en-US', { maximumFractionDigits: 1 });
    switch (unit) {
        case 'bytes': return n >= 1048576 ? `${fmt(n / 1048576)} MB` : n >= 1024 ? `${fmt(n / 1024)} KB` : `${fmt(n)} bytes`;
        case 'count': return fmt(n);
        case 'per_minute': return `${fmt(n)} a minute`;
        case 'per_hour': return `${fmt(n)} an hour`;
        case 'per_day': return `${fmt(n)} a day`;
        case 'days': return `${fmt(n)} ${n === 1 ? 'day' : 'days'}`;
        default: return unit ? `${fmt(n)} ${String(unit).replace(/_/g, ' ')}` : fmt(n);
    }
}

module.exports = { createNetworkStatus, numbers, build, quickStart, faq, FAQ, BUILD, limitAmount, publicCaps };
