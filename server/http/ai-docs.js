'use strict';

/**
 * GET /docs/ai (AI Exchange P8): the developer guide to OpenVibe AI's API, as the decisions of the AI Exchange define it
 * (CHECKPOINT D1-D3, D8'-D10): one base URL for the OpenAI and Anthropic SDKs, exact model ids and dynamic names, the
 * `x_openvibe` object every answer carries, prices to the nano-dollar with holds, streaming, errors, BYOK, privacy and
 * sandbox. Behind SERVICES_MODEL_EXPLORER with the model pages (no public promise before the owner approves); noindex.
 */

const { asyncRouter } = require('./router');
const { html } = require('../render/html');
const { send } = require('../render/layout');
const { usd, cost } = require('../domain/model-catalog');

const AI = 'https://ai.openvibe.services';

function createAiDocsRoutes(appCtx) {
    const { config } = appCtx;
    const r = asyncRouter();

    r.get('/docs/ai', (req, res, next) => {
        if (process.env.SERVICES_MODEL_EXPLORER !== '1') return next();
        const example = { retail: { nano_usd_per_m: { input: '40000000', cached_read: '10000000', cache_write: '40000000', output: '120000000' }, per_request_nano_usd: '0' } };
        const ex = { input: 1200, cached_read: 8000, cache_write: 0, output: 400 };
        const exCost = cost(example, ex);
        const block = (id, code) => html`<div class="mx-snippet"><div class="mx-snippet-head"><span>${id}</span><button type="button" class="mx-copy" data-mx-copy="#doc-${id.replace(/[^a-z]+/gi, '-').toLowerCase()}" hidden>Copy</button></div><pre id="doc-${id.replace(/[^a-z]+/gi, '-').toLowerCase()}" tabindex="0"><code>${code}</code></pre></div>`;
        const row = (cells) => html`<tr>${cells.map((c, i) => (i ? html`<td>${c}</td>` : html`<th scope="row">${c}</th>`))}</tr>`;
        const body = html`<div class="mx mx-doc">
<header class="mx-hero is-small">
  <p class="mx-eye">Docs · OpenVibe AI</p>
  <h1>One API for every model, priced to the nano-dollar</h1>
  <p class="mx-lede">Use the OpenAI or the Anthropic SDK you already have. Name an exact model build, or let OpenVibe pick within your rules. Every answer says which model ran, where, at what price.</p>
  <p class="mx-note" role="note"><b>Preview.</b> This describes the API as the AI Exchange opens it; until then the catalog and the prices are examples.</p>
  <nav class="mx-jump" aria-label="On this page"><a href="#start">Start</a><a href="#models">Models</a><a href="#answer">What every answer says</a><a href="#prices">Prices and caps</a><a href="#stream">Streaming</a><a href="#errors">Errors</a><a href="#keys">Your keys, privacy, sandbox</a></nav>
</header>

<section class="mx-card" id="start" aria-labelledby="start-h">
  <h2 id="start-h">Start in three steps</h2>
  <ol class="mx-steps">
    <li><b>A project and an app.</b> Create a project on <a href="/projects">Projects</a> and a sandbox app in it; ask for <code>ai.app.run</code> on the app (sandbox apps get it at once).</li>
    <li><b>Its key.</b> The app's credential is shown once. Keep it in your environment as <code>OPENVIBE_API_KEY</code>; OpenVibe stores only its hash.</li>
    <li><b>The first call.</b> The base URL is <code>${AI}/v1</code> for the OpenAI SDK and <code>${AI}</code> for the Anthropic one.</li>
  </ol>
  ${block('curl', `curl ${AI}/v1/chat/completions \\\n  -H "Authorization: Bearer $OPENVIBE_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "openvibe/auto", "messages": [{"role": "user", "content": "Hello"}]}'`)}
  <details class="mx-more"><summary>OpenAI and Anthropic SDKs (2)</summary>
  ${block('OpenAI SDK · JavaScript', `import OpenAI from 'openai';\n\nconst ai = new OpenAI({ baseURL: '${AI}/v1', apiKey: process.env.OPENVIBE_API_KEY });\nconst reply = await ai.chat.completions.create({ model: 'openvibe/auto', messages: [{ role: 'user', content: 'Hello' }] });\nconsole.log(reply.choices[0].message.content, reply.x_openvibe);`)}
  ${block('Anthropic SDK · Python', `import anthropic, os\n\nai = anthropic.Anthropic(base_url="${AI}", api_key=os.environ["OPENVIBE_API_KEY"])\nreply = ai.messages.create(model="openvibe/auto", max_tokens=1024, messages=[{"role": "user", "content": "Hello"}])\nprint(reply.content[0].text)`)}
  </details>
</section>

<section class="mx-card" id="models" aria-labelledby="models-h">
  <h2 id="models-h">Choosing a model</h2>
  <p><b>An exact id</b> names one build: <code>org/model[:quant]@revision</code>, for example <code>qwen/qwen3-8b-abliterated:q4_k_m@3f2a1c9</code>. It runs that artifact or fails with an error; it is never swapped for another quantization, variant or model. <a href="/models">The model list</a> has every id.</p>
  <p><b>A dynamic name</b> picks per request among the models you allow, after your hard rules (exact pins, privacy class, the capabilities the request needs, your price cap):</p>
  <div class="mx-table-wrap is-vs"><table class="mx-table mx-vs"><thead><tr><th scope="col">Name</th><th scope="col">Picks</th></tr></thead><tbody>
    ${row([html`<code>openvibe/auto</code>`, 'Balanced, and the default for the old name openvibe'])}
    ${row([html`<code>openvibe/economy</code>`, 'The lowest cost per successful answer above the quality floor'])}
    ${row([html`<code>openvibe/balanced</code>`, 'Cost, success rate and speed weighed together'])}
    ${row([html`<code>openvibe/fast</code>`, 'The quickest first token under your cost cap'])}
    ${row([html`<code>openvibe/private</code>`, 'Only OpenVibe-run machines or your own; never an outside provider'])}
  </tbody></table></div>
  <p class="mx-hint">Abliterated, fine-tuned and quantized variants are measured on their own; a variant never borrows its base model's score. A change to the weights is no promise of quality or of no refusals.</p>
</section>

<section class="mx-card" id="answer" aria-labelledby="answer-h">
  <h2 id="answer-h">What every answer says</h2>
  <p>Each response carries an <code>x_openvibe</code> object (in a stream: just before <code>[DONE]</code>), beside the <code>run_id</code>, <code>provider</code>, <code>fallback_used</code> and <code>cost_usd</code> it already has:</p>
  <div class="mx-table-wrap is-vs"><table class="mx-table mx-vs"><tbody>
    ${row([html`<code>resolved_model</code>`, 'The exact id that answered'])}
    ${row([html`<code>revision</code>`, 'Its build'])}
    ${row([html`<code>provider_access</code>`, html`Who ran it: <code>OWN_DEPLOYMENT</code> (OpenVibe), <code>AUTHORIZED_WHOLESALE</code> (a licensed partner), <code>CUSTOMER_BYOK</code> (your key)`])}
    ${row([html`<code>rate_version</code>`, 'The price version the charge used, so any bill can be reproduced'])}
    ${row([html`<code>policy</code>`, 'The dynamic name\'s policy, when you used one'])}
    ${row([html`<code>fallback_reason</code>`, 'Why another model answered, when one did (a dynamic name only)'])}
  </tbody></table></div>
</section>

<section class="mx-card" id="prices" aria-labelledby="prices-h">
  <h2 id="prices-h">Prices and caps</h2>
  <p>A model has four prices per million tokens: input, cached input, cache write and output, and sometimes a per-request fee. One request costs each class's tokens times its price, <b>rounded up once per class</b>, to the nano-dollar ($0.000000001). Nothing is rounded per token or to a cent.</p>
  <p>For example, at $0.04 / $0.01 / $0.04 / $0.12 per million, a request of 1,200 input, 8,000 cached and 400 output tokens costs <b>${usd(exCost)}</b>; a thousand of them, ${usd(exCost, { per: 1000 })}.</p>
  <p><b>Credits</b> pay for it: your project's prepaid balance in dollars. Before a request runs, the most it can cost is held from your balance; when it ends, only what was used is charged and the rest is released at once. Set <code>max_cost_usd</code> on a request to cap it; a request that would exceed your balance or cap is refused before it runs (402).</p>
</section>

<section class="mx-card" id="stream" aria-labelledby="stream-h">
  <h2 id="stream-h">Streaming</h2>
  <p>Set <code>"stream": true</code>: Server-Sent Events, as the OpenAI and Anthropic SDKs expect. Stop reading, or abort, and you pay for the tokens produced until then, never the cap. A provider that fails after the first token ends the stream with an error; two models' answers are never spliced into one.</p>
</section>

<section class="mx-card" id="errors" aria-labelledby="errors-h">
  <h2 id="errors-h">Errors</h2>
  <div class="mx-table-wrap is-vs"><table class="mx-table mx-vs"><thead><tr><th scope="col">Status</th><th scope="col">Code</th><th scope="col">Means</th></tr></thead><tbody>
    ${row(['404', html`<code>ai.model_not_found</code>`, 'No such model id'])}
    ${row(['400', html`<code>ai.model_unavailable</code>`, 'The exact build cannot run now; nothing else was tried'])}
    ${row(['402', html`<code>billing.insufficient_funds</code>`, 'Your Credits (or your cap) do not cover the request'])}
    ${row(['409', html`<code>billing.hold_key_reused</code>`, 'An idempotency key was reused with a different request'])}
    ${row(['429', html`<code>rate_limited</code>`, 'Too many requests for your project now; retry after the header says'])}
  </tbody></table></div>
</section>

<section class="mx-card" id="keys" aria-labelledby="keys-h">
  <h2 id="keys-h">Your own keys, privacy, sandbox</h2>
  <ul class="mx-list">
    <li><b>Your own provider keys (BYOK).</b> Add them on Your AI; requests they serve are billed by that provider, and OpenVibe charges nothing for them.</li>
    <li><b>Private.</b> <code>openvibe/private</code>, or a private class in your project, keeps a request on OpenVibe-run machines or your own. No prompt or answer is kept in logs, caches or analytics.</li>
    <li><b>Sandbox apps</b> run on sandbox credit only: test freely, nothing is charged and no paid provider is used.</li>
  </ul>
</section>
</div>`;
        send(res, 200, { viewer: req.viewer, config, path: req.originalUrl, index: false, title: 'OpenVibe AI API', description: 'The OpenVibe AI API: exact models, dynamic names, prices to the nano-dollar.', crumbs: [{ label: 'Docs', href: '/docs' }, { label: 'AI' }], scripts: ['js/models.js'], css: ['css/models.css'], body });
    });

    return r;
}

module.exports = { createAiDocsRoutes };
