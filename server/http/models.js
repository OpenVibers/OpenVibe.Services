'use strict';

/**
 * The model explorer (AI Exchange P8): the developer portal's pages for OpenVibe AI's models.
 *
 *   GET /models                 every model: search, variant, what it can do, who supplies it; priced for a workload
 *   GET /models/compare?ids=…   two to four side by side, with the cost of each workload
 *   GET /models/:id             one model: exact identity, lineage, prices with a calculator, quality, how to call it
 *
 * Behind SERVICES_MODEL_EXPLORER (off): no price is promised in public before the owner approves the catalog. The
 * pages work without JavaScript (forms and links); js/models.js makes the filters and the calculator live. Data is
 * domain/model-catalog.js (OpenVibe AI's catalog, or the preview fixture, which every page then labels).
 */

const { asyncRouter } = require('./router');
const { html, raw, esc } = require('../render/html');
const { send } = require('../render/layout');
const catalogLib = require('../domain/model-catalog');

const { cost, usd, perMillion, filterModels, sortModels, WORKLOADS, VARIANTS, ACCESS, AVAILABILITY, COMPONENTS } = catalogLib;
const CAPS = { tools: 'Tools', json: 'JSON', vision: 'Vision', stream: 'Streaming' };
const COMPONENT_NAMES = { input: 'Input', cached_read: 'Cached input', cache_write: 'Cache write', output: 'Output' };
const AI_URL = 'https://ai.openvibe.services';

const enabled = () => process.env.SERVICES_MODEL_EXPLORER === '1';
const badge = (text, tone) => html`<span class="mx-badge is-${tone || 'plain'}">${text}</span>`;
const variantBadge = (m) => (m.variant ? badge(VARIANTS[m.variant], m.variant === 'abliterated' ? 'abl' : m.variant === 'original' ? 'plain' : 'tuned') : '');
const accessBadges = (m) => m.access.map((a) => badge(ACCESS[a][0], ACCESS[a][1]));
const href = (id) => `/models/${encodeURIComponent(id)}`;
const n = (x) => Number(x || 0).toLocaleString('en-US');
const ctx = (t) => (t >= 1000 ? `${Math.round(t / 1024)}K` : String(t || '—'));

function createModelRoutes(appCtx) {
    const { config } = appCtx;
    const catalog = appCtx.modelCatalog || catalogLib.createModelCatalog({ config, log: appCtx.log || console });
    const r = asyncRouter();

    const page = (req, res, o) => send(res, o.status || 200, {
        viewer: req.viewer, config, path: req.originalUrl, index: false, scripts: ['js/models.js'], css: ['css/models.css'], ...o,
    });
    const previewNote = (data) => (data.source === 'preview'
        ? html`<p class="mx-note" role="note"><b>Preview.</b> These are example entries and example prices, to shape this page. The live catalog comes from OpenVibe AI.</p>`
        : data.problem ? html`<p class="mx-note is-bad" role="status">${data.problem.detail}</p>` : '');

    r.get('/models', async (req, res, next) => {
        if (!enabled()) return next();
        const data = await catalog.list();
        const q = req.query || {};
        const workload = WORKLOADS[q.workload] ? q.workload : 'chat';
        const sort = ['price', 'context', 'name'].includes(q.sort) ? q.sort : 'price';
        const caps = [].concat(q.cap || []).filter((c) => CAPS[c]);
        const shown = sortModels(filterModels(data.models, { ...q, cap: caps }), sort, workload);
        const counts = Object.fromEntries(Object.keys(VARIANTS).map((v) => [v, data.models.filter((m) => m.variant === v).length]));
        const usage = WORKLOADS[workload].usage;
        const option = (value, label, selected, extra = '') => raw(`<option value="${esc(value)}"${selected ? ' selected' : ''}${extra}>${esc(label)}</option>`);

        const aliases = data.aliases.length ? html`<section class="mx-aliases" aria-labelledby="mx-aliases-h">
<div class="mx-sec-head"><h2 id="mx-aliases-h">Or let OpenVibe pick</h2><p>A dynamic name picks a model per request, within your rules, and every answer says which model ran and why.</p></div>
<ul class="mx-alias-list">${data.aliases.map((a) => html`<li><a class="mx-alias" href="${href(a.id)}"><code>${a.id}</code><b>${a.name}</b><span>${a.description || ''}</span></a></li>`)}</ul></section>` : '';

        const rows = shown.map((m) => {
            const per = m.retail && m.retail.nano_usd_per_m ? m.retail.nano_usd_per_m : {};
            const [avail, availTone] = AVAILABILITY[m.availability];
            return html`<tr>
<td class="mx-c-model" data-label="Model"><div class="mx-model-cell"><a class="mx-name" href="${href(m.id)}">${m.name}</a><code class="mx-id">${m.id}</code><span class="mx-tags">${variantBadge(m)}${m.quant ? badge(m.quant.toUpperCase(), 'plain') : ''}${badge(avail, availTone)}</span></div></td>
<td data-label="Context">${ctx(m.context_tokens)}</td>
<td class="mx-c-can" data-label="Can"><span class="mx-caps">${m.capabilities.filter((c) => CAPS[c] && c !== 'stream').map((c) => html`<span class="mx-cap">${CAPS[c]}</span>`)}</span></td>
<td class="mx-num" data-label="Input / 1M">${perMillion(per.input)}</td>
<td class="mx-num" data-label="Output / 1M">${perMillion(per.output)}</td>
<td class="mx-num mx-strong" data-label="${WORKLOADS[workload].label}">${usd(cost(m, usage))}</td>
<td data-label="Supplied by"><span class="mx-tags">${accessBadges(m)}</span></td>
<td class="mx-pick" data-label="Compare"><label class="mx-check"><input type="checkbox" name="ids" value="${m.id}" form="mx-compare" data-mx-pick><span class="mx-sr">Compare ${m.name}</span></label></td>
</tr>`;
        });

        const body = html`<div class="mx">
<header class="mx-hero">
  <p class="mx-eye">OpenVibe AI · Models</p>
  <h1>Every model, its exact build, its real price</h1>
  <p class="mx-lede">Original and abliterated variants, each pinned to a revision and benchmarked on its own. Prices to the nano-dollar, for the work you actually send.</p>
  ${previewNote(data)}
</header>
${aliases}
<form class="mx-bar" method="get" action="/models" data-mx-filters role="search" aria-label="Filter models">
  <label class="mx-search"><span class="mx-sr">Search</span><input type="search" name="q" value="${q.q || ''}" placeholder="Search models" autocomplete="off" spellcheck="false"></label>
  <label class="mx-field">Variant <select name="variant" data-ov-title="Variant">${option('all', `All (${data.models.length})`, !q.variant || q.variant === 'all')}${Object.entries(VARIANTS).filter(([v]) => counts[v]).map(([v, label]) => option(v, `${label} (${counts[v]})`, q.variant === v))}</select></label>
  <label class="mx-field">Priced for <select name="workload" data-ov-title="Price for">${Object.entries(WORKLOADS).map(([k, w]) => option(k, w.label, workload === k, ` data-desc="${esc(w.desc)}"`))}</select></label>
  <label class="mx-field">Sort <select name="sort" data-ov-title="Sort by">${option('price', 'Cheapest first', sort === 'price')}${option('context', 'Longest context', sort === 'context')}${option('name', 'Name', sort === 'name')}</select></label>
  <fieldset class="mx-needs"><legend>Needs</legend>${Object.entries(CAPS).filter(([c]) => c !== 'stream').map(([c, label]) => html`<label class="mx-chip"><input type="checkbox" name="cap" value="${c}"${caps.includes(c) ? raw(' checked') : ''}><span>${label}</span></label>`)}</fieldset>
  <button class="mx-apply" type="submit">Show</button>
</form>
<p class="mx-count" aria-live="polite"><b>${shown.length}</b> of ${data.models.length} models · priced for a ${WORKLOADS[workload].label.toLowerCase()} (${WORKLOADS[workload].desc})</p>
<form id="mx-compare" method="get" action="/models/compare"></form>
${shown.length ? html`<div class="mx-table-wrap"><table class="mx-table">
<thead><tr><th scope="col">Model</th><th scope="col">Context</th><th scope="col">Can</th><th scope="col" class="mx-num">Input / 1M</th><th scope="col" class="mx-num">Output / 1M</th><th scope="col" class="mx-num">${WORKLOADS[workload].label}</th><th scope="col">Supplied by</th><th scope="col"><span class="mx-sr">Compare</span></th></tr></thead>
<tbody>${rows}</tbody></table></div>` : html`<p class="mx-empty">No model matches. <a href="/models">Show every model</a>.</p>`}
<div class="mx-compare-bar"><span data-mx-picked>Pick two to four models to compare them.</span><button class="mx-apply" type="submit" form="mx-compare">Compare</button></div>
</div>`;
        page(req, res, { title: 'Models', description: 'OpenVibe AI models: exact builds, variants and prices.', crumbs: [{ label: 'Docs', href: '/docs' }, { label: 'Models' }], body });
    });

    r.get('/models/compare', async (req, res, next) => {
        if (!enabled()) return next();
        const data = await catalog.list();
        const ids = [].concat(req.query.ids || []).map(String).slice(0, 4);
        const picked = ids.map((id) => data.models.find((m) => m.id === id)).filter(Boolean);
        if (picked.length < 2) {
            return page(req, res, { status: 200, title: 'Compare models', crumbs: [{ label: 'Models', href: '/models' }, { label: 'Compare' }], body: html`<div class="mx"><h1>Compare models</h1><p class="mx-empty">Pick two to four models on <a href="/models">the model list</a>, then press Compare.</p></div>` });
        }
        const line = (label, cell) => html`<tr><th scope="row">${label}</th>${picked.map((m) => html`<td>${cell(m)}</td>`)}</tr>`;
        const bars = Object.entries(WORKLOADS).map(([k, w]) => {
            const costs = picked.map((m) => cost(m, w.usage));
            const max = costs.reduce((a, b) => (b > a ? b : a), 1n);
            const min = costs.reduce((a, b) => (b < a ? b : a), costs[0]);
            return html`<div class="mx-bars"><h3>${w.label} <small>${w.desc}</small></h3>${picked.map((m, i) => html`<div class="mx-bar-row${costs[i] === min ? ' is-best' : ''}"><span class="mx-bar-name">${m.name}</span><span class="mx-bar-track"><span class="mx-bar-fill" style="width:${Math.max(2, Number((costs[i] * 1000n) / max) / 10)}%"></span></span><span class="mx-bar-val">${usd(costs[i])}<small> · ${usd(costs[i], { per: 1000 })} per 1,000</small></span></div>`)}</div>`;
        });
        const body = html`<div class="mx">
<header class="mx-hero is-small"><p class="mx-eye">Compare</p><h1>${picked.map((m) => m.name).join(' · ')}</h1>${previewNote(data)}</header>
<section class="mx-card"><h2>What each costs</h2>${bars}</section>
<section class="mx-card"><h2>Side by side</h2><div class="mx-table-wrap is-vs"><table class="mx-table mx-vs">
<thead><tr><th scope="col"><span class="mx-sr">Attribute</span></th>${picked.map((m) => html`<th scope="col"><a href="${href(m.id)}">${m.name}</a></th>`)}</tr></thead>
<tbody>
${line('Exact id', (m) => html`<code class="mx-id">${m.id}</code>`)}
${line('Variant', (m) => variantBadge(m))}
${line('Base model', (m) => m.base_model || '—')}
${line('Quantization', (m) => (m.quant || '—').toUpperCase())}
${line('Context', (m) => `${n(m.context_tokens)} tokens`)}
${line('Can', (m) => html`<span class="mx-caps">${m.capabilities.filter((c) => CAPS[c]).map((c) => html`<span class="mx-cap">${CAPS[c]}</span>`)}</span>`)}
${COMPONENTS.map((c) => line(`${COMPONENT_NAMES[c]} / 1M`, (m) => perMillion(((m.retail || {}).nano_usd_per_m || {})[c])))}
${line('Supplied by', (m) => html`<span class="mx-tags">${accessBadges(m)}</span>`)}
${line('Runs on', (m) => m.hardware || '—')}
${line('License', (m) => m.license || '—')}
${line('Quality', (m) => (m.quality && m.quality.score != null ? `${m.quality.score} (${n(m.quality.samples)} samples)` : 'Not benchmarked yet'))}
</tbody></table></div></section></div>`;
        page(req, res, { title: 'Compare models', crumbs: [{ label: 'Models', href: '/models' }, { label: 'Compare' }], body });
    });

    r.get('/models/:id', async (req, res, next) => {
        if (!enabled()) return next();
        const data = await catalog.list();
        const m = await catalog.get(String(req.params.id));
        if (!m) return next();
        const q = req.query || {};
        const usage = Object.fromEntries(COMPONENTS.map((c) => [c, Math.max(0, Math.min(10_000_000, Math.floor(Number(q[c]) || (c === 'input' ? 1200 : c === 'output' ? 400 : 0))))]));
        const crumbs = [{ label: 'Models', href: '/models' }, { label: m.name }];
        const snippetCurl = `curl ${AI_URL}/v1/chat/completions \\\n  -H "Authorization: Bearer $OPENVIBE_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "${m.id}", "messages": [{"role": "user", "content": "Hello"}]}'`;
        const snippetJs = `import OpenAI from 'openai';\n\nconst ai = new OpenAI({ baseURL: '${AI_URL}/v1', apiKey: process.env.OPENVIBE_API_KEY });\nconst reply = await ai.chat.completions.create({\n  model: '${m.id}',\n  messages: [{ role: 'user', content: 'Hello' }],\n});\nconsole.log(reply.choices[0].message.content, reply.openvibe);`;
        const snippetPy = `from openai import OpenAI\nimport os\n\nai = OpenAI(base_url="${AI_URL}/v1", api_key=os.environ["OPENVIBE_API_KEY"])\nreply = ai.chat.completions.create(\n    model="${m.id}",\n    messages=[{"role": "user", "content": "Hello"}],\n)\nprint(reply.choices[0].message.content)`;
        const snippetAnthropic = `import Anthropic from '@anthropic-ai/sdk';\n\nconst ai = new Anthropic({ baseURL: '${AI_URL}', apiKey: process.env.OPENVIBE_API_KEY });\nconst reply = await ai.messages.create({\n  model: '${m.id}',\n  max_tokens: 1024,\n  messages: [{ role: 'user', content: 'Hello' }],\n});`;
        const snippet = (id, label, code) => html`<div class="mx-snippet"><div class="mx-snippet-head"><span>${label}</span><button type="button" class="mx-copy" data-mx-copy="#${id}" hidden>Copy</button></div><pre id="${id}" tabindex="0"><code>${code}</code></pre></div>`;

        if (m.dynamic) {
            const body = html`<div class="mx"><header class="mx-hero is-small"><p class="mx-eye">Dynamic model</p><h1>${m.name}</h1><p class="mx-lede">${m.description || ''}</p><p><code class="mx-id is-big">${m.id}</code></p>${previewNote(data)}</header>
<section class="mx-card"><h2>How it picks</h2><p>Policy <b>${m.policy}</b>. Only models you allow are considered: your exact pins, your privacy class, the capabilities the request needs and your price cap come first, then the policy chooses among what is left. Every answer carries an <code>openvibe</code> object naming the model, revision and supplier that answered, the price version, and why.</p></section>
<section class="mx-card"><h2>Use it</h2>${snippet('mx-s-curl', 'curl', snippetCurl)}${snippet('mx-s-js', 'OpenAI SDK · JavaScript', snippetJs)}</section></div>`;
            return page(req, res, { title: m.name, crumbs, body });
        }

        const per = (m.retail && m.retail.nano_usd_per_m) || {};
        const one = cost(m, usage);
        const [avail, availTone] = AVAILABILITY[m.availability];
        const fact = (label, value) => html`<div class="mx-fact"><dt>${label}</dt><dd>${value}</dd></div>`;
        const body = html`<div class="mx">
<header class="mx-hero is-small">
  <p class="mx-eye">${m.org || ''} · ${m.family || ''}</p>
  <h1>${m.name}</h1>
  <p class="mx-idline"><code class="mx-id is-big" id="mx-the-id">${m.id}</code><button type="button" class="mx-copy" data-mx-copy="#mx-the-id" hidden>Copy id</button></p>
  <p class="mx-tags">${variantBadge(m)}${m.quant ? badge(m.quant.toUpperCase(), 'plain') : ''}${badge(avail, availTone)}${accessBadges(m)}</p>
  ${m.modification && m.modification.note ? html`<p class="mx-lede">${m.modification.note}</p>` : ''}
  ${previewNote(data)}
</header>
<div class="mx-grid">
<section class="mx-card mx-price" aria-labelledby="mx-price-h">
  <h2 id="mx-price-h">Price</h2>
  <table class="mx-rates"><tbody>${COMPONENTS.map((c) => html`<tr><th scope="row">${COMPONENT_NAMES[c]}</th><td class="mx-num">${perMillion(per[c])} <small>per 1M tokens</small></td></tr>`)}${m.retail && m.retail.per_request_nano_usd && m.retail.per_request_nano_usd !== '0' ? html`<tr><th scope="row">Per request</th><td class="mx-num">${usd(m.retail.per_request_nano_usd)}</td></tr>` : ''}</tbody></table>
  <form class="mx-calc" method="get" action="${href(m.id)}" data-mx-calc data-rates="${JSON.stringify({ ...per, per_request: (m.retail && m.retail.per_request_nano_usd) || '0' })}">
    <p class="mx-calc-title">Your request</p>
    <div class="mx-calc-grid">${COMPONENTS.map((c) => html`<label>${COMPONENT_NAMES[c]}<input type="number" inputmode="numeric" min="0" max="10000000" step="1" name="${c}" value="${usage[c]}"></label>`)}</div>
    <output class="mx-calc-out" data-mx-out><span><b data-mx-one>${usd(one)}</b> per request</span><span><b data-mx-k>${usd(one, { per: 1000 })}</b> per 1,000</span><span><b data-mx-m>${usd(one, { per: 1000000 })}</b> per million</span></output>
    <button class="mx-apply" type="submit" data-mx-calc-submit>Work it out</button>
    <p class="mx-hint">Each token class is rounded up once per request, to the nano-dollar. Billing charges what was used, never the cap you set.</p>
  </form>
</section>
<section class="mx-card" aria-labelledby="mx-id-h">
  <h2 id="mx-id-h">Exactly this build</h2>
  <dl class="mx-facts">
    ${fact('Base model', m.base_model || 'This is the original')}
    ${fact('Changed by', m.modification ? m.modification.method : 'Unchanged')}
    ${fact('Revision', html`<code>${m.revision}</code>`)}
    ${fact('Weights SHA-256', m.sha256 ? html`<code class="mx-hash">${m.sha256}</code>` : 'Published when it is deployed')}
    ${fact('License', m.license || '—')}
    ${fact('Context', `${n(m.context_tokens)} tokens`)}
    ${fact('Longest answer', `${n(m.max_output_tokens)} tokens`)}
    ${fact('Runs on', m.hardware || '—')}
  </dl>
  <p class="mx-hint">An exact id runs this build or fails; it is never swapped for another quantization or variant.</p>
</section>
<section class="mx-card" aria-labelledby="mx-can-h">
  <h2 id="mx-can-h">What it can do</h2>
  <p class="mx-caps is-big">${Object.entries(CAPS).map(([c, label]) => html`<span class="mx-cap${m.capabilities.includes(c) ? ' is-on' : ' is-off'}">${m.capabilities.includes(c) ? '✓' : '—'} ${label}</span>`)}</p>
  <p class="mx-hint">Reads ${(((m.modalities || {}).input) || ['text']).join(', ')}; writes ${(((m.modalities || {}).output) || ['text']).join(', ')}.</p>
</section>
<section class="mx-card" aria-labelledby="mx-q-h">
  <h2 id="mx-q-h">Quality</h2>
  ${m.quality && m.quality.score != null ? html`<p class="mx-score"><b>${m.quality.score}</b> on OpenVibe Bench, from ${n(m.quality.samples)} samples.</p>` : html`<p>Not benchmarked yet. It is measured on its own on <a href="https://bench.openvibe.services">OpenVibe Bench</a> before it serves paid traffic; a variant never borrows its base model's score.</p>`}
</section>
</div>
<section class="mx-card mx-use" aria-labelledby="mx-use-h">
  <h2 id="mx-use-h">Call it</h2>
  ${snippet('mx-s-curl', 'curl', snippetCurl)}
  <details class="mx-more"><summary>More ways (3)</summary>${snippet('mx-s-js', 'OpenAI SDK · JavaScript', snippetJs)}${snippet('mx-s-py', 'OpenAI SDK · Python', snippetPy)}${snippet('mx-s-an', 'Anthropic SDK · JavaScript', snippetAnthropic)}</details>
</section>
</div>`;
        page(req, res, { title: m.name, description: `${m.name}: ${m.id}`, crumbs, body });
    });

    return r;
}

module.exports = { createModelRoutes };
