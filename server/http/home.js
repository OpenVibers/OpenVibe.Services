'use strict';
/**
 * The home page's content beyond the kit's generic sections, built for a developer on a phone (the owner 2026-10-28:
 * "act more like an app, not a huge long web page"): the platform in numbers as one strip, the building blocks as a
 * launcher, quick-start code folded under the working examples, and the questions developers ask as an accordion.
 * Every number is counted from the pinned contracts or read from OpenVibe.Network's public status within the last
 * minute; nothing here is typed in as a figure.
 */
const showcase = require('openvibe-shared/showcase');
const kit = require('openvibe-shared/kit');

const esc = showcase.esc;
const EXAMPLES = 'https://github.com/OpenVibers/OpenVibe.Examples';
const example = (name) => `${EXAMPLES}/tree/main/examples/${name}`;
const sdkInstall = (v) => `npm i https://codeload.github.com/OpenVibers/OpenVibe.SDK/tar.gz/refs/tags/v${v}`;

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

/** The platform in numbers: one strip (it scrolls sideways on a phone), counted from the pinned contracts and SDK, plus
 * services up when Network answered. Each number opens the reference it counts. */
function numbers({ docs, programmable, status }) {
    const items = [
        [programmable.length, 'services you can call', '/docs/services'],
        [docs.capabilities.filter((c) => c.grantable && c.visibility === 'public').length, 'capabilities an app can request', '/docs/capabilities?grantable=1'],
        [docs.events.length, 'event types to subscribe to', '/docs/events'],
        [docs.sdk.length, 'SDK modules, typed', '/docs/sdk'],
        status ? [status.up, `services up now, of ${status.checked} checked`, 'https://openvibe.network/status'] : null,
    ].filter((x) => x && Number(x[0]) > 0);
    return `<div class="sc-sec svc-num">${kit.stats(items, { label: 'The platform in numbers' })}</div>`;
}

// The building blocks (plan track K, the owner 2026-10-24: consumer products for people, "while also having our services
// website" for builders): every service an app can call, by a plain name short enough for a phone's launcher tile, with
// one line of what it is (short enough for a wide screen's tile) and the place that documents it. On the home they are
// a launcher (openvibe-shared showcase.apps): a phone shows the icons three to a row under the name, wider screens add
// the line. People who only want to use OpenVibe are sent to Vibe.
const BLOCKS = [
    { icon: 'ai', name: 'AI API', text: 'Many models, one API', href: 'https://ai.openvibe.services/' },
    { icon: 'actor', name: 'Agents', text: 'Hand a task to an agent', href: 'https://openvibe.actor/docs' },
    { icon: 'codes', name: 'Coding', text: 'Coding agents, one router', href: 'https://openvibe.codes/' },
    { icon: 'run', name: 'Compute', text: 'Jobs on nodes, per second', href: 'https://openvibe.run/' },
    { icon: 'zone', name: 'Storage', text: 'S3-compatible zones', href: 'https://openvibe.zone/' },
    { icon: 'space', name: 'Hosting', text: 'Host sites and apps', href: 'https://openvibe.space/' },
    { icon: 'media', name: 'Media API', text: 'Video, clips and files', href: 'https://openvibe.media/' },
    { icon: 'events', name: 'Events', text: 'Topics, cursors, webhooks', href: 'https://openvibe.events/' },
    { icon: 'search', name: 'Search', text: 'The network in one query', href: '/docs/api/search' },
    { icon: 'account', name: 'Sign-in', text: 'OAuth 2.0 with PKCE', href: '/oauth' },
    { icon: 'billing', name: 'Payments', text: 'Tips and memberships', href: 'https://openvibe.vip/' },
    { icon: 'chat', name: 'Chat', text: 'Support chat, one tag', href: 'https://openvibe.chat/developers' },
    { icon: 'tools', name: 'Tools', text: 'Hundreds of tools as APIs', href: 'https://openvibe.tools/developers' },
    { icon: 'bot', name: 'Robots', text: 'Robots through one gate', href: 'https://openvibe.bot/' },
    { icon: 'play', name: 'Games', text: 'Achievements and saves', href: 'https://play.openvibe.network/' },
];

/** The building blocks as a launcher, then every service's API reference (See all) and the way to Vibe. */
function blocks({ apis }) {
    return showcase.apps({
        id: 'blocks', title: 'The building blocks',
        lede: 'Every OpenVibe product runs on these, and your app can call the same ones with a project\'s token.',
        items: BLOCKS.map((b) => ({ ...b, icon: `ov:${b.icon}` })),
        more: apis ? { href: '/docs/api', label: `See all ${apis} service APIs` } : null,
    }).replace(/<\/section>$/, () => '<p class="sc-note">Just here to use OpenVibe? <a href="https://openvibe.chat/vibe">Chat with Vibe</a> or <a href="https://openvibe.network/">see the network</a>.</p></section>');
}

// Working examples in OpenVibe.Examples (MIT, each with a smoke test): the quickest start is one of these.
const BUILD = [
    { title: 'Sign people in with OpenVibe', text: 'oauth-app · PKCE, no secret in a web app', href: example('oauth-app') },
    { title: 'Store and serve files', text: 'media-uploader · your project\'s Media space', href: example('media-uploader') },
    { title: 'React to what happens', text: 'webhook-consumer · topics and signed webhooks', href: example('webhook-consumer') },
    { title: 'Run tools as jobs', text: 'tool-job · follow its stream across restarts', href: example('tool-job') },
    { title: 'Build a chat bot', text: 'chat-bot · stays in its room, says it is a bot', href: example('chat-bot') },
];

/** The hero's code: it runs as written against production with the pinned SDK, with no key (test/home.test.js). */
function heroCode({ sdkVersion }) {
    return `// openvibe-sdk v${sdkVersion}
const sdk = require('openvibe-sdk');
const ov = sdk.createClient();      // public reads need no key

const search = sdk.search.createSearchClient(ov);
const { results } = await search.query('go live');

const registry = sdk.registry.createRegistryClient(ov);
const services = await registry.services();`;
}

const pre = (code, lang) => `<pre tabindex="0"><code class="language-${lang}">${esc(code)}</code></pre>`;

/**
 * Quick start: the working examples first (one tap to the code), then what is read once, folded: a new app from a
 * template, and an app's calls past the hero's code. Both samples run against production with the pinned SDK.
 */
function quickStart({ sdkVersion }) {
    const app = `// ${sdkInstall(sdkVersion)}
const sdk = require('openvibe-sdk');
const tokens = sdk.auth.createServiceTokenClient({
    clientId: process.env.OV_CLIENT_ID, clientSecret: process.env.OV_CLIENT_SECRET,
});
const ov = sdk.createClient({ tokenProvider: tokens });
const { unverifiedClaims } = await tokens.getTokenInfo({ audience: 'openvibe.media' });
const media = sdk.media.createMediaClient(ov, { app: unverifiedClaims.project_id });
const file = await media.upload(bytes, { filename: 'logo.png', contentType: 'image/png' });`;
    const http = `curl -s https://openvibe.network/oauth/token \\
  -d grant_type=client_credentials \\
  -d client_id="$OV_CLIENT_ID" -d client_secret="$OV_CLIENT_SECRET" \\
  -d audience=openvibe.media
# → {"access_token":"…","token_type":"Bearer","expires_in":300,…}`;
    const template = `npx --package=https://codeload.github.com/OpenVibers/OpenVibe.Examples/tar.gz/refs/tags/v0.3.0 \\
    create-openvibe-app my-app --template web`;
    return `<section class="sc-sec" id="quick-start" aria-labelledby="h-quick-start"><h2 id="h-quick-start">Quick start</h2>
<p class="sc-lede">${esc(`openvibe-sdk v${sdkVersion}, for Node and the browser. Public reads need no key.`)}</p>
${kit.list(BUILD.map((b) => kit.row({ href: b.href, title: b.title, sub: b.text })), { title: 'Start from a working example', more: { href: EXAMPLES, label: 'All examples' } })}
${kit.fold({ id: 'qs-template', title: 'A new app from a template', meta: 'npx', body: `${pre(template, 'bash')}<p class="sc-note">Templates: web, server, bot and mod. <a href="/mod">Every way to mod the network</a>.</p>` })}
${kit.fold({ id: 'qs-app', title: 'Calls with an app\'s key', meta: 'Node and curl', body: `<p class="sc-note">A sandbox app in your project has a client id and secret. Upload a file from Node:</p>${pre(app, 'js')}<p class="sc-note">Or get its token over HTTP, from any language:</p>${pre(http, 'bash')}` })}</section>`;
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

/** The questions as an accordion (openvibe-shared showcase.faq): each answer one tap away, the first one open. */
function faq() {
    return showcase.faq({ id: 'faq', title: 'Questions developers ask', items: FAQ.map((p) => [p.q, p.a]) });
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

module.exports = { createNetworkStatus, numbers, blocks, heroCode, quickStart, faq, FAQ, BLOCKS, BUILD, limitAmount };
