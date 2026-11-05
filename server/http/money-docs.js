'use strict';

/**
 * GET /docs/vibes and /docs/balance (D12, MONEY.md): the developer guides to Vibes Pay and to a project's Balance.
 *
 * They are hand-written guides, not generated from a package: the platform's money decisions are the source, and
 * every number is quoted from Billing's own surfaces. A "Preview" note says plainly that the paid surfaces open when
 * the owner enables Billing's billing.vibes / billing.credits namespaces; the sandbox works without real money.
 *
 *   /docs/vibes    what Vibes are, Vibes Pay step by step (SDK and plain HTTP), webhooks and their signature,
 *                  sandbox, refunds, payouts, limits
 *   /docs/balance  how metered usage bills a project's Balance, adding money, moving money to a project
 */

const { asyncRouter } = require('./router');
const { html } = require('../render/html');
const { send } = require('../render/layout');

const BILLING = 'https://billing.openvibe.network';
const PAY = 'https://openvibe.network/pay';

function block(id, code) {
    const slug = id.replace(/[^a-z]+/gi, '-').toLowerCase();
    return html`<div class="mx-snippet"><div class="mx-snippet-head"><span>${id}</span><button type="button" class="mx-copy" data-mx-copy="#doc-${slug}" hidden>Copy</button></div><pre id="doc-${slug}" tabindex="0"><code>${code}</code></pre></div>`;
}

const row = (cells) => html`<tr>${cells.map((c, i) => (i ? html`<td>${c}</td>` : html`<th scope="row">${c}</th>`))}</tr>`;

function preview() {
    return html`<p class="mx-note" role="note"><b>Preview.</b> These surfaces open when OpenVibe enables Billing's
money settings. The sandbox works now and never touches real money.</p>`;
}

function createMoneyDocsRoutes(appCtx) {
    const { config } = appCtx;
    const r = asyncRouter();

    r.get('/docs/vibes', (req, res) => {
        const body = html`<div class="mx mx-doc">
<header class="mx-hero is-small">
  <p class="mx-eye">Docs · Vibes</p>
  <h1>Vibes, and Vibes Pay for your app</h1>
  <p class="mx-lede">Vibes are OpenVibe's social currency: whole numbers, bought with money, spent on tips, cheers,
  paid messages, consumer tools and in-app items. They are never earned, and they are not cash.</p>
  ${preview()}
  <nav class="mx-jump" aria-label="On this page"><a href="#what">What Vibes are</a><a href="#steps">Pay step by step</a><a href="#sdk">Server SDK</a><a href="#http">Plain HTTP</a><a href="#webhooks">Webhooks</a><a href="#sandbox">Sandbox</a><a href="#refunds">Refunds</a><a href="#payouts">Payouts</a><a href="#limits">Limits</a></nav>
</header>

<section class="mx-card" id="what" aria-labelledby="what-h">
  <h2 id="what-h">What Vibes are</h2>
  <p>One Vibes price is a <b>whole number</b>, set by the app or the product: 50 Vibes, 1,250 Vibes. A person gets
  Vibes with <b>Get Vibes</b> (a pack with a card, or from their Balance) and spends them. Vibes are never
  <b>earned</b>: OpenCoins are the reward currency. Vibes cannot be moved back into Balance; a creator or app that
  receives Vibes cashes them out under the payout rules below.</p>
  <p>Use Vibes when the price is social and simple — a tip, a cheer, a paid message, an image or another consumer
  tool, an item in your app. Use <b>Balance</b> (dollars, exact to the nano-dollar) for metered and professional
  usage: see <a href="/docs/balance">the Balance guide</a>. A product never asks a person to choose between the two
  for the same thing.</p>
</section>

<section class="mx-card" id="steps" aria-labelledby="steps-h">
  <h2 id="steps-h">Vibes Pay step by step</h2>
  <ol class="mx-steps">
    <li><b>Your server creates a charge</b> with your app token (capability <code>billing.vibes.charge</code>):
    <code>amount</code> in whole Vibes, a <code>description</code>, your <code>reference</code> (the order id, and the
    idempotency key) and a <code>return_url</code>. Billing answers a <code>pay_url</code> and a charge id.</li>
    <li><b>The person pays on OpenVibe's sheet</b> at <code>pay_url</code>. It shows your app and the item, the
    price in Vibes and their Vibes, with one button — “Pay 50 Vibes”, or “Get Vibes” when they are short. It never
    shows a card form: the Vibes are already bought.</li>
    <li><b>Billing moves the Vibes</b>, atomically and once, from the person to your project's Vibes wallet. The
    charge becomes <code>paid</code>.</li>
    <li><b>Your server learns it</b> from a signed webhook, and can always ask
    <code>GET /api/v1/vibes/charges/:id</code>. Fulfil only after one of those says <code>paid</code>; never trust the
    page's word alone.</li>
    <li><b>Refund, pay out and watch the limits</b> as described below.</li>
  </ol>
  <p>In the browser, <code>openvibe-shared/vibes-pay.js</code> opens <code>pay_url</code> and resolves
  <code>{ status }</code> from a <code>postMessage</code> whose origin is <code>https://openvibe.network</code>:</p>
  ${block('Browser · vibes-pay.js', `<script src="https://openvibe.network/shared/vibes-pay.js" defer></script>\n\n<button data-ov-vibes-pay="${PAY}/vch_…">Pay with Vibes</button>\n\n<script>\n  const { status } = await OpenVibe.vibes.pay('${PAY}/vch_…');\n  if (status === 'paid') showThanks();\n</script>`)}
  <p class="mx-hint">The button binds itself in the Vibes accent and both themes. The page result is a hint to
  refresh; the server's webhook or charge read is the confirmation.</p>
</section>

<section class="mx-card" id="sdk" aria-labelledby="sdk-h">
  <h2 id="sdk-h">Server SDK</h2>
  <p><code>openvibe-sdk/vibes</code> is in openvibe-sdk v0.84.0 and later:</p>
  ${block('Node · openvibe-sdk/vibes', `const { createVibesClient } = require('openvibe-sdk/vibes');\n\nconst vibes = createVibesClient({\n  appToken: process.env.OPENVIBE_APP_TOKEN,      // capability billing.vibes.charge\n  billingUrl: '${BILLING}',\n});\n\nconst charge = await vibes.charges.create({\n  amount: 50,                                     // whole Vibes, never a float\n  description: 'Sticker pack: Neon cats',\n  reference: 'order_123',                          // your order id; also the Idempotency-Key\n  return_url: 'https://myapp.example/thanks',\n});\n// { id: 'vch_…', pay_url: '${PAY}/vch_…', status: 'pending', expires_at: '…' }\n\nconst current = await vibes.charges.get(charge.id); // { status: 'paid', … }\nawait vibes.charges.refund(charge.id, { reason: 'requested by the buyer' });`)}
  <p>The app token stays on your server. A token that expires can be supplied as a
  <code>tokenProvider</code> (a function, or an SDK token client with <code>getToken()</code>/<code>invalidate()</code>);
  a 401 invalidates it and retries once with the same <code>Idempotency-Key</code>. A float, zero or a negative
  amount throws before anything is sent. Billing's problem+json becomes a <code>VibesError</code> with
  <code>status</code>, <code>code</code>, <code>body</code> and <code>retryable</code>.</p>
</section>

<section class="mx-card" id="http" aria-labelledby="http-h">
  <h2 id="http-h">Plain HTTP</h2>
  <p>Everything the SDK does is these three requests. The app token carries <code>billing.vibes.charge</code>; the
  person's token is not used by your server.</p>
  ${block('Create a charge', `POST ${BILLING}/api/v1/vibes/charges\nAuthorization: Bearer $OPENVIBE_APP_TOKEN\nContent-Type: application/json\nIdempotency-Key: order_123\n\n{\n  "amount": 50,\n  "description": "Sticker pack: Neon cats",\n  "reference": "order_123",\n  "return_url": "https://myapp.example/thanks"\n}\n\n→ 201\n{ "id": "vch_…", "pay_url": "${PAY}/vch_…", "status": "pending", "expires_at": "…" }`)}
  ${block('Read a charge', `GET ${BILLING}/api/v1/vibes/charges/vch_…\nAuthorization: Bearer $OPENVIBE_APP_TOKEN\n\n→ 200 { "id": "vch_…", "amount": 50, "status": "paid", "reference": "order_123", … }`)}
  ${block('Refund a charge', `POST ${BILLING}/api/v1/vibes/charges/vch_…/refund\nAuthorization: Bearer $OPENVIBE_APP_TOKEN\nContent-Type: application/json\n\n{ "reason": "requested by the buyer" }`)}
  <p>The <code>reference</code> is the idempotency key. The same reference with the same request is the same charge;
  changing the request under it is refused, never charged twice. A create whose answer was lost can be retried
  safely.</p>
</section>

<section class="mx-card" id="webhooks" aria-labelledby="webhooks-h">
  <h2 id="webhooks-h">Webhooks and their signature</h2>
  <p>Register an HTTPS endpoint for your app. Billing sends a signed delivery on <code>paid</code> and
  <code>refunded</code> (event types <code>billing.vibes.charge.paid</code> and
  <code>billing.vibes.charge.refunded</code>), retried with backoff until your server answers 2xx.</p>
  <p>Every delivery carries <code>X-OpenVibe-Signature-V2</code>:</p>
  <pre tabindex="0"><code>t=&lt;unix seconds&gt;,v2=&lt;hex HMAC-SHA256 of "&lt;t&gt;.&lt;raw body&gt;"&gt;</code></pre>
  <p>Verify the <b>raw bytes</b> you received, not a re-serialised JSON object, with the app's webhook secret. Check
  the signature in constant time, reject a timestamp more than 300 seconds from your clock, and return 2xx quickly.
  The legacy <code>X-OpenVibe-Signature</code> (<code>sha256=&lt;hex&gt;</code> of the body alone) is still accepted
  by the SDK for receivers that have not moved; it carries no time and can be replayed, so use v2.</p>
  ${block('Node · verify the raw body', `const express = require('express');\nconst { verifyWebhook } = require('openvibe-sdk/vibes');\nconst app = express();\n\napp.post('/webhooks/vibes', express.raw({ type: 'application/json' }), (req, res) => {\n  const ok = verifyWebhook(\n    req.body,                                    // a Buffer: the raw body\n    req.get('X-OpenVibe-Signature-V2'),\n    process.env.OPENVIBE_VIBES_WEBHOOK_SECRET,\n  );\n  if (!ok) return res.sendStatus(401);\n\n  const event = JSON.parse(req.body.toString('utf8'));\n  // Mark the order paid by event.data.reference (or the charge id); the same delivery may arrive twice.\n  markPaid(event);\n  res.sendStatus(204);\n});`)}
  <p>The same check is <code>vibes.webhooks.verify(rawBody, signatureHeader, secret)</code> on the SDK client — pass
  the raw bytes, never a re-serialised object. Delivery is at least once: key your work on the charge id (or your
  reference) and do nothing when it is already paid. If a delivery never arrives, poll <code>GET /api/v1/vibes/charges/:id</code>; that read is the same
  authority as the webhook.</p>
</section>

<section class="mx-card" id="sandbox" aria-labelledby="sandbox-h">
  <h2 id="sandbox-h">Sandbox</h2>
  <p>A sandbox app creates sandbox charges, paid with sandbox Vibes: test grants worth nothing. They never touch a
  person's real Vibes or a project's real Vibes wallet, and a sandbox app never charges a production account. Use the
  sandbox to exercise the whole flow — create, pay sheet, webhook, refund — before your app is reviewed for
  production.</p>
</section>

<section class="mx-card" id="refunds" aria-labelledby="refunds-h">
  <h2 id="refunds-h">Refunds</h2>
  <p><code>POST /api/v1/vibes/charges/:id/refund</code> returns a paid charge's Vibes to the person, from your
  project's Vibes wallet. The charge becomes <code>refunded</code> and the app gets the refunded webhook. A charge
  can be refunded once; a repeat is answered from the charge's status rather than moving the Vibes again. Only the
  app that created the charge may refund it.</p>
</section>

<section class="mx-card" id="payouts" aria-labelledby="payouts-h">
  <h2 id="payouts-h">Payouts</h2>
  <p>The Vibes your app receives sit in your project's Vibes wallet. The project's owner cashes them out under the
  platform's payout rules — the same rules a creator's payable balance uses: a minimum, a hold, and a payout
  provider. They are never converted into Balance. The current thresholds and hold are on
  <a href="/docs/billing">the Billing policy page</a>, which renders Billing's own policy, not a copy.</p>
</section>

<section class="mx-card" id="limits" aria-labelledby="limits-h">
  <h2 id="limits-h">Limits and errors</h2>
  <p>The owner sets Vibes Pay's limits in OpenVibe's AI settings, namespace <code>billing.vibes</code>: the largest
  single charge, a person's daily Vibes spend in apps, and whether Vibes Pay is on. Sandbox is separate.</p>
  <div class="mx-table-wrap is-vs"><table class="mx-table mx-vs"><thead><tr><th scope="col">Status</th><th scope="col">Means</th></tr></thead><tbody>
    ${row(['401', 'No app token, or it expired. Mint one with billing.vibes.charge.'])}
    ${row(['402', 'The person is short of Vibes; show Get Vibes on the sheet and let them top up.'])}
    ${row(['403', 'Vibes Pay is off for apps, or this app does not hold the capability.'])}
    ${row(['404', 'No such charge for this app.'])}
    ${row(['409', 'The reference was reused with a different request; never retry it as a new charge.'])}
    ${row(['429', 'Too many requests; retry after the header says.'])}
  </tbody></table></div>
</section>
</div>`;
        send(res, 200, {
            viewer: req.viewer, config, path: req.originalUrl, index: true,
            title: 'Vibes and Vibes Pay', description: 'What Vibes are and how to sell something with Vibes Pay: the SDK, plain HTTP, webhooks, sandbox, refunds, payouts and limits.',
            crumbs: [{ label: 'Docs', href: '/docs' }, { label: 'Vibes' }], css: ['css/models.css'], scripts: ['js/models.js'], body,
        });
    });

    r.get('/docs/balance', (req, res) => {
        const body = html`<div class="mx mx-doc">
<header class="mx-hero is-small">
  <p class="mx-eye">Docs · Balance</p>
  <h1>Balance: dollars, exact to the nano-dollar</h1>
  <p class="mx-lede">Balance is prepaid US dollars, one for one: $1 of Balance is $1. It pays for metered and
  professional usage — the AI API, the Exchange, compute, developer tools and team plans. Vibes are for tips and
  consumer products; <a href="/docs/vibes">the Vibes guide</a> is separate.</p>
  ${preview()}
  <nav class="mx-jump" aria-label="On this page"><a href="#who">Who holds one</a><a href="#usage">How usage bills</a><a href="#read">Read it</a><a href="#add">Add money</a><a href="#move">Move money</a><a href="#sandbox">Sandbox</a><a href="#words">The words</a></nav>
</header>

<section class="mx-card" id="who" aria-labelledby="who-h">
  <h2 id="who-h">Who holds one</h2>
  <ul class="mx-list">
    <li><b>A person.</b> Your own playground runs and your own API calls with your personal token use your personal
    Balance.</li>
    <li><b>A project.</b> Usage by a project's apps and keys uses <b>the project's Balance</b>: the developer pays for
    the app's usage. A project's admins add money to it directly, or move money in from their personal Balance.</li>
  </ul>
  <p>In Billing's ledger a person's Balance is a USD account owned by <code>user:&lt;usr_id&gt;</code>; a project's
  is owned by <code>project:&lt;prj_id&gt;</code>. A project's page on OpenVibe.Services shows its Balance at
  <code>/projects/&lt;prj_id&gt;/balance</code>.</p>
</section>

<section class="mx-card" id="usage" aria-labelledby="usage-h">
  <h2 id="usage-h">How usage bills a project's Balance</h2>
  <p>A request is priced before it starts. The most it can cost is <b>held</b> from the project's available
  Balance; when it ends, only what was used is <b>charged</b> and the rest is released at once. A request that would
  exceed the balance, or its own cap, is refused before it runs (<code>402 billing.insufficient_funds</code>). If a
  provider fails mid-stream, only the tokens produced until then are charged; the cap is never the charge.</p>
  <p>The arithmetic is integer <b>nano-USD</b> ($0.000000001), never a float. A model prices four token classes per
  million tokens — input, cached read, cache write and output — plus an optional per-request fee. Each class is
  rounded up once per request, then added:</p>
  <pre tabindex="0"><code>charge = ceil(input_tokens    × rate_in / 1e6)
       + ceil(cached_tokens   × rate_cached / 1e6)
       + ceil(cache_write     × rate_cache / 1e6)
       + ceil(output_tokens   × rate_out / 1e6)
       + per_request_nano_usd</code></pre>
  <p>For example, 1,200 input at $0.04/M, 8,000 cached at $0.01/M and 400 output at $0.12/M costs
  <b>$0.0001136</b> — the exact integer Billing stores. A statement shows every charge with the key or app that
  made it. Set <code>max_cost_usd</code> on a request to cap it.</p>
</section>

<section class="mx-card" id="read" aria-labelledby="read-h">
  <h2 id="read-h">Read it</h2>
  <p>With the person's Network user token, Billing answers their Balance and the projects they administer:</p>
  ${block('GET /api/me/balance', `GET ${BILLING}/api/me/balance\nAuthorization: Bearer <the person's token>\n\n→ 200 {\n  "personal": { "balance_nano_usd": "12400000000", "held_nano_usd": "0", "available_nano_usd": "12400000000" },\n  "projects": [ { "owner": { "type": "project", "id": "prj_…" }, "balance_nano_usd": "…", … } ]\n}`)}
  <p>A project's statement (its Balance, held and available, and its recent charges) is the same read scoped to the
  project, with <code>project_id</code>; only an admin or owner of the project may see it. Everything is a decimal
  string of integer nano-USD: parse it as a BigInt, never as a float.</p>
</section>

<section class="mx-card" id="add" aria-labelledby="add-h">
  <h2 id="add-h">Add money</h2>
  <p><b>Add money</b> in <a href="https://openvibe.network/wallet">the wallet</a> opens a top-up through any of the
  platform's payment providers: PowerChat, Stripe, PayPal, CCBill or NOWPayments. The provider handles the card or
  the wallet; OpenVibe never stores a card number. A project's admins add money to the project directly, or move
  their own Balance in. A top-up is not enabled until the owner turns on the platform's top-up switch.</p>
</section>

<section class="mx-card" id="move" aria-labelledby="move-h">
  <h2 id="move-h">Move money to a project</h2>
  <p>Your Balance → a project's Balance is a transfer. It is atomic and idempotent, and it can never spend money a
  running request is holding. Use <b>Move to a project</b> in the wallet, or the API:</p>
  ${block('POST /api/me/balance/transfers', `POST ${BILLING}/api/me/balance/transfers\nAuthorization: Bearer <the person's token>\nContent-Type: application/json\n\n{\n  "to_project_id": "prj_…",\n  "amount_nano_usd": "5000000000",\n  "idempotency_key": "move-2026-11-04-1"\n}\n\n→ 201 { "transfer": { … }, "from": { … }, "to": { … } }`)}
  <p><code>amount_nano_usd</code> is a positive integer string: 5,000,000,000 is $5.00. The same idempotency key
  with the same request replays the first answer; the same key with a different request is refused. Moving money
  the other way — a project's Balance to a person — is not a top-up or a withdrawal; it is a refund or a payout under
  Billing's rules.</p>
</section>

<section class="mx-card" id="sandbox" aria-labelledby="sandbox-h">
  <h2 id="sandbox-h">Sandbox</h2>
  <p>A sandbox app spends only its project's <b>sandbox Balance</b>, never the paid one. Test freely: no card, no
  real money, and nothing a production request could spend. The project page shows the sandbox Balance apart from
  the real Balance.</p>
</section>

<section class="mx-card" id="words" aria-labelledby="words-h">
  <h2 id="words-h">The words</h2>
  <ul class="mx-list">
    <li><b>Balance</b> is dollars, added with <i>Add money</i> and used by metered and professional products.</li>
    <li><b>Vibes</b> are the social currency, bought with <i>Get Vibes</i> and spent; never earned.</li>
    <li><b>OpenCoins</b> are the reward currency, earned by watching and chatting.</li>
  </ul>
  <p>A product never asks a person to choose between Balance and Vibes for the same thing. Use Balance for exact,
  metered usage; use <a href="/docs/vibes">Vibes</a> for tips, cheers and consumer items.</p>
</section>
</div>`;
        send(res, 200, {
            viewer: req.viewer, config, path: req.originalUrl, index: true,
            title: 'Balance', description: 'How a project\'s Balance pays for metered usage, adding money and moving money to a project.',
            crumbs: [{ label: 'Docs', href: '/docs' }, { label: 'Balance' }], css: ['css/models.css'], scripts: ['js/models.js'], body,
        });
    });

    return r;
}

module.exports = { createMoneyDocsRoutes };
