'use strict';
// The Markdown twins of openvibe.services' public pages (openvibe-shared/agent-layer), rendered by the same
// view builders the routes use (http/pages.js and http/docs.js + render/layout.js's renderPage), so a twin
// cannot drift from its page. Anonymous only: /projects, /staff and the API are never rendered here.
const { createPageViews } = require('./http/pages');
const { createDocsViews } = require('./http/docs');
const { renderPage } = require('./render/layout');

function createAgentPages(ctx) {
    const pages = createPageViews(ctx);
    const docs = createDocsViews(ctx);

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
