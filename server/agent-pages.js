'use strict';
// The Markdown twins of openvibe.services' public pages (openvibe-shared/agent-layer), rendered by the same
// view builders the routes use (http/pages.js and http/docs.js + render/layout.js's renderPage), so a twin
// cannot drift from its page. Anonymous only: /projects, /staff and the API are never rendered here.
const { createPageViews } = require('./http/pages');
const { createDocsViews, createDocsRoutes } = require('./http/docs');

// The docs pages the docs router builds inline (contracts, capabilities, events, services, tools, SDK, …) are twinned by
// running that router signed out: each named a twin that answered 404 (11-03, tools/twin-named-check.js).
const DOCS_ROUTER_RE = /^\/docs\/(?:contracts|capabilities|events|services|tools|billing|limits|export|sdk|adr|updates)(?:\/[^/]+)?$/;

/** One GET through `router`, as a signed-out visitor; the HTML of a 200 answer, or null. */
function renderThrough(router, mount, path, query) {
    return new Promise((resolve) => {
        const search = query ? query.toString() : '';
        const sub = path.slice(mount.length) || '/';
        const req = {
            method: 'GET', url: sub + (search ? `?${search}` : ''), originalUrl: path + (search ? `?${search}` : ''), baseUrl: mount, path: sub,
            params: {}, query: Object.fromEntries(new URLSearchParams(search)), headers: { accept: 'text/html', host: 'localhost' },
            viewer: { kind: 'anonymous' }, get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        const headers = {};
        const res = {
            statusCode: 200,
            get: (k) => headers[String(k).toLowerCase()], set(k, v) { headers[String(k).toLowerCase()] = v; return this; },
            status(code) { this.statusCode = code; return this; }, type(t) { headers['content-type'] = t; return this; },
            send(body) { resolve(this.statusCode === 200 && /html/.test(String(headers['content-type'] || '')) && typeof body === 'string' ? body : null); return this; },
            json() { resolve(null); return this; }, end() { resolve(null); return this; }, redirect() { resolve(null); return this; },
        };
        try { router.handle(req, res, () => resolve(null)); } catch { resolve(null); }
    });
}
const { renderPage } = require('./render/layout');

function createAgentPages(ctx) {
    const pages = createPageViews(ctx);
    const docs = createDocsViews(ctx);
    const docsRouter = createDocsRoutes(ctx);

    const twin = (o, path, query) => {
        if (!o) return null;
        const search = query && query.toString();
        return {
            html: renderPage({
                ...o, index: true, config: ctx.config, path: search ? `${path}?${search}` : path,
                viewer: { kind: 'anonymous' },
            }),
        };
    };

    async function renderPublicPage(path, { query } = {}) {
        if (path === '/') return twin(await pages.home(), '/');
        if (path === '/updates') return twin(pages.updates(), path);
        if (path === '/mod') return twin(pages.mod(), path);
        if (path === '/policy') return twin(pages.policy(), path);
        if (path === '/policy/rfc') return twin(pages.policyRfc(), path);
        if (path === '/policy/compatibility') return twin(pages.policyCompatibility(), path);
        if (path === '/policy/licensing') return twin(pages.policyLicensing(), path);
        if (path === '/policy/transparency') return twin(pages.policyTransparency(), path);
        if (path === '/docs') return twin(docs.index(), path);
        if (path === '/docs/api') return twin(docs.apiExplorer(), path);
        if (DOCS_ROUTER_RE.test(path)) {
            const htmlOut = await renderThrough(docsRouter, '/docs', path, query);
            return htmlOut ? { html: htmlOut } : null;
        }
        const api = /^\/docs\/api\/([^/]+)$/.exec(path);
        if (api) {
            const id = decodeURIComponent(api[1]);
            return twin(docs.apiService(id, { publicOnly: query && query.get('public') === '1' }), path, query);
        }
        return null;
    }

    return { renderPublicPage };
}

module.exports = { createAgentPages };
