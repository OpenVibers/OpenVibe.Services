'use strict';
// AGT-2: POST /mcp, the OpenVibe network as one read-only MCP server (server/http/network-mcp.js), against a fake
// network: the frame, two sites' manifests and OpenAPI documents, and their endpoints.
const assert = require('assert');
const http = require('http');
const express = require('express');
const { createNetworkMcp } = require('../server/http/network-mcp');

const calls = [];
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
async function fakeFetch(url, opts = {}) {
    calls.push({ url: String(url), opts });
    const u = new URL(url);
    if (u.href === 'https://openvibe.network/api/frame') return json({ nav: [{ url: 'https://openvibe.deals/' }, { url: 'https://openvibe.casino/learn' }, { url: 'http://insecure.example/' }, { url: '/relative' }] });
    if (u.pathname === '/.well-known/agent.json' && u.host === 'openvibe.deals') return json({ mcp: { url: '/mcp' }, id: 'deals', name: 'OpenVibe.Deals', purpose: 'Deals.', home: 'https://openvibe.deals', api: 'https://openvibe.deals/api/v1', openapi: 'https://openvibe.deals/openapi.json' });
    if (u.pathname === '/.well-known/agent.json' && u.host === 'openvibe.casino') return json({ mcp: { url: 'https://evil.example/mcp' }, id: 'casino', name: 'OpenVibe.Casino', purpose: 'Casino.', openapi: 'https://evil.example/openapi.json' });
    if (u.href === 'https://openvibe.deals/openapi.json') return json({ openapi: '3.1.0', paths: { '/api/v1/deals/hot': { get: { summary: 'The hot deals', parameters: [{ name: 'limit', in: 'query' }] } }, '/api/v1/deals/{id}': { get: { summary: 'One deal' }, delete: { summary: 'Remove' } }, '/api/v1/internal/x': { get: { 'x-openvibe-visibility': ['internal'] } }, '/api/v1/votes': { post: { summary: 'Vote' } } } });
    if (u.href === 'https://openvibe.casino/openapi.json') return json({ openapi: '3.1.0', servers: [{ url: 'https://openvibe.casino/api/v1' }], paths: { '/games': { get: { summary: 'Every game' } }, '/games/{id}': { get: { summary: 'One game' } } } });
    if (u.origin === 'https://openvibe.deals' && u.pathname === '/api/v1/deals/hot') return json({ deals: [{ id: 'd1' }], limit: u.searchParams.get('limit'), auth: (opts.headers || {}).Authorization || null });
    if (u.origin === 'https://openvibe.deals' && u.pathname === '/api/v1/deals/big') return new Response('x'.repeat(300 * 1024), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.origin === 'https://openvibe.deals' && u.pathname === '/api/v1/deals/moved') return new Response(null, { status: 301, headers: { location: 'https://elsewhere.example/' } });
    if (u.origin === 'https://openvibe.casino' && u.pathname === '/api/v1/games/blackjack') return json({ game: { id: 'blackjack' } });
    // Deals' own MCP: tools/list, and tools/call echoing who called (the Bearer it was sent, or none).
    if (u.href === 'https://openvibe.deals/mcp') {
        const m = JSON.parse(opts.body);
        if (m.method === 'tools/list') return json({ jsonrpc: '2.0', id: m.id, result: { tools: [
            { name: 'deals_hot', description: 'The hot deals right now, with their prices.', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } } },
            { name: 'deals_alert', description: 'Make a price alert for a product.', inputSchema: { type: 'object', properties: { product: { type: 'string' }, below: { type: 'number' } }, required: ['product'] } },
        ] } });
        if (m.method === 'tools/call' && m.params.name === 'deals_hot') return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: '{}' }], structuredContent: { deals: [{ id: 'd1', price: 9 }, { id: 'd2', price: 30 }, { id: 'd3', price: 12 }], limit: m.params.arguments.limit, auth: (opts.headers || {}).Authorization || null } } })}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        if (m.method === 'tools/call') return json({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'Sign in to make an alert' }], isError: true } });
    }
    return json({ error: 'not found' }, 404);
}

(async () => {
    const app = express().use(createNetworkMcp({ config: { network: { url: 'https://openvibe.network' } }, fetchImpl: fakeFetch, log: { warn() {} } }));
    const server = await new Promise((r) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const rpc = async (body, headers = {}) => { const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }); return { status: r.status, headers: r.headers, body: r.status === 202 ? null : await r.json() }; };
    const call = async (name, args) => (await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } })).body.result;
    try {
        // The protocol.
        const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
        assert.strictEqual(init.status, 200);
        assert.strictEqual(init.body.result.protocolVersion, '2025-03-26', 'a supported version is echoed');
        assert.strictEqual(init.body.result.serverInfo.name, 'openvibe-network');
        assert.strictEqual(init.headers.get('access-control-allow-origin'), '*');
        assert.strictEqual((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202, 'a notification has no answer');
        const list = (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).body.result.tools.map((t) => t.name);
        assert.deepStrictEqual(list, ['openvibe_sites', 'openvibe_operations', 'openvibe_get', 'openvibe_search', 'openvibe_execute']);
        assert.strictEqual((await rpc({ jsonrpc: '2.0', id: 3, method: 'nope' })).body.error.code, -32601);
        assert.strictEqual((await rpc([])).body.error.code, -32600);
        assert.strictEqual((await rpc({ jsonrpc: '2.0', id: 4, method: 'ping' }, { 'mcp-protocol-version': '1999-01-01' })).status, 400);
        const batch = await rpc([{ jsonrpc: '2.0', id: 5, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }, { jsonrpc: '2.0', id: 6, method: 'ping' }]);
        assert.deepStrictEqual(batch.body.map((m) => m.id), [5, 6], 'a batch answers its requests, not its notifications');
        assert.strictEqual((await fetch(`${base}/mcp`)).status, 405);
        assert.strictEqual((await fetch(`${base}/mcp`, { method: 'OPTIONS' })).status, 204);

        // openvibe_sites: the frame's https origins only, each from its own manifest; a foreign openapi is not trusted.
        const sites = (await call('openvibe_sites', {})).structuredContent.sites;
        assert.deepStrictEqual(sites.map((s) => s.id), ['casino', 'deals']);
        assert.strictEqual(sites.find((s) => s.id === 'casino').openapi, 'https://openvibe.casino/openapi.json', 'an OpenAPI URL on another origin is replaced by the site\'s own');

        // openvibe_operations: GETs only, internal ones left out, the document's server prefix applied.
        const deals = (await call('openvibe_operations', { site: 'deals' })).structuredContent.operations;
        assert.deepStrictEqual(deals.map((o) => o.path), ['/api/v1/deals/hot', '/api/v1/deals/{id}']);
        assert.deepStrictEqual(deals[0].query_params, ['limit']);
        const casino = (await call('openvibe_operations', { site: 'openvibe.casino' })).structuredContent.operations;
        assert.deepStrictEqual(casino.map((o) => o.path), ['/api/v1/games', '/api/v1/games/{id}'], 'the server path prefix is part of the path');
        assert.strictEqual((await call('openvibe_operations', { site: 'nowhere' })).isError, true);

        // openvibe_get: a documented GET, anonymously, on the site's own origin.
        const hot = await call('openvibe_get', { site: 'deals', path: '/api/v1/deals/hot', query: { limit: 5 } });
        assert.strictEqual(hot.isError, false);
        assert.strictEqual(hot.structuredContent.operation, '/api/v1/deals/hot', 'an exact path wins over a {param} template');
        assert.deepStrictEqual([hot.structuredContent.status, hot.structuredContent.body.limit, hot.structuredContent.body.auth], [200, '5', null], 'no credential is sent');
        const sent = calls.find((c) => c.url.startsWith('https://openvibe.deals/api/v1/deals/hot'));
        assert.ok(!('cookie' in (sent.opts.headers || {})) && !('Authorization' in (sent.opts.headers || {})) && sent.opts.redirect === 'manual' && (sent.opts.method || 'GET') === 'GET');
        assert.strictEqual((await call('openvibe_get', { site: 'casino', path: '/api/v1/games/blackjack' })).structuredContent.body.game.id, 'blackjack', 'a {param} takes one segment');
        for (const [args, why] of [
            [{ site: 'deals', path: '/api/v1/votes' }, 'a POST-only path is not callable'],
            [{ site: 'deals', path: '/api/v1/internal/x' }, 'an internal operation is not callable'],
            [{ site: 'deals', path: '/api/v1/deals/a/b' }, 'a parameter is one segment'],
            [{ site: 'deals', path: '/api/v1/deals/../internal/x' }, 'no dot segments'],
            [{ site: 'deals', path: '/api/v1/deals/a%2Fb' }, 'no encoded slashes'],
            [{ site: 'deals', path: 'https://evil.example/x' }, 'a path, never a URL'],
            [{ site: 'deals', path: '/api/v1/deals/hot?x=1' }, 'the query goes in query'],
            [{ site: 'evil.example', path: '/' }, 'only the network\'s sites'],
            [{ site: 'deals', path: '/api/v1/deals/hot', query: { 'bad key': 1 } }, 'query keys are plain'],
            [{ site: 'deals', path: '/api/v1/deals/hot', query: { q: 'x'.repeat(501) } }, 'query values are short'],
        ]) assert.strictEqual((await call('openvibe_get', args)).isError, true, why);
        const big = await call('openvibe_get', { site: 'deals', path: '/api/v1/deals/big' });
        assert.deepStrictEqual([big.structuredContent.truncated, typeof big.structuredContent.body, big.structuredContent.body.length], [true, 'string', 256 * 1024], 'cut at 256 KB');
        const moved = await call('openvibe_get', { site: 'deals', path: '/api/v1/deals/moved' });
        assert.deepStrictEqual([moved.structuredContent.status, moved.structuredContent.location], [301, 'https://elsewhere.example/'], 'a redirect is reported, not followed');
        assert.ok(!calls.some((c) => c.url.startsWith('https://elsewhere.example')), 'and nothing fetched it');
        const missing = await call('openvibe_get', { site: 'deals', path: '/api/v1/deals/zzz' });
        assert.deepStrictEqual([missing.isError, missing.structuredContent.status], [true, 404], 'the site\'s own 404 comes back as an error result');

        // MCP 2026-07-28 (stateless; 2026-11-16, openvibe-sdk/mcp): the version and the method on every request,
        // server/discover, resultType on every result, a cacheable tool list; the handshake above still works.
        const mcpKit = require('openvibe-sdk/mcp');
        const modern = async (method, params = {}, extra = {}) => {
            const built = mcpKit.modernRequest({ id: 50, method, params, clientInfo: { name: 'test', version: '1' } });
            const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...built.headers, ...extra }, body: JSON.stringify(built.body) });
            return { status: r.status, body: await r.json() };
        };
        let m = await modern('server/discover');
        assert.deepStrictEqual([m.status, m.body.result.resultType, m.body.result.cacheScope], [200, 'complete', 'public']);
        assert.ok(m.body.result.supportedVersions.includes('2026-07-28') && m.body.result.supportedVersions.includes('2025-06-18'));
        m = await modern('tools/list');
        assert.deepStrictEqual([m.status, m.body.result.resultType, m.body.result.cacheScope], [200, 'complete', 'public']);
        m = await modern('tools/call', { name: 'openvibe_get', arguments: { site: 'deals', path: '/api/v1/deals/hot' } });
        assert.deepStrictEqual([m.status, m.body.result.resultType], [200, 'complete']);
        m = await modern('tools/list', {}, { 'Mcp-Method': 'tools/call' });
        assert.deepStrictEqual([m.status, m.body.error.code], [400, -32020], 'a header that disagrees is refused');
        m = await modern('resources/list');
        assert.deepStrictEqual([m.status, m.body.error.code], [404, -32601], 'an unknown method is a 404');
        const pre = await fetch(`${base}/mcp`, { method: 'OPTIONS' });
        assert.match(pre.headers.get('access-control-allow-headers'), /Mcp-Method.*Mcp-Name/, 'the preflight lets the new headers through');
        // The network's tools in two (plan §AD.26 step 2): every site's own MCP tools, found and called from one script.
        const found = await call('openvibe_search', { query: 'hot deals prices' });
        assert.strictEqual(found.isError, false);
        assert.deepStrictEqual(found.structuredContent.tools[0], { call: 'tools.deals_deals_hot', site: 'deals', tool: 'deals_hot', signature: 'tools.deals_deals_hot(input: { limit?: number }): Promise<any>', description: '[OpenVibe.Deals] The hot deals right now, with their prices.' });
        assert.strictEqual(found.structuredContent.total, 2, 'Casino\'s MCP is on a foreign host: never offered');
        assert.ok(!calls.some((c) => c.url.startsWith('https://evil.example')), 'and never asked');
        const ran = await call('openvibe_execute', { code: 'const h = await tools.deals_deals_hot({ limit: 3 }); console.log(h.deals.length); return { cheap: h.deals.filter((d) => d.price < 20).map((d) => d.id), auth: h.auth };' });
        assert.strictEqual(ran.isError, false, JSON.stringify(ran.structuredContent));
        assert.deepStrictEqual(ran.structuredContent, { result: { cheap: ['d1', 'd3'], auth: null }, logs: ['3'], calls: 1 }, 'only what the script returns; anonymous without a sign-in');
        const signed = await rpc({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'openvibe_execute', arguments: { code: 'return (await tools.deals_deals_hot({})).auth;' } } }, { authorization: 'Bearer tok-person-0123456789' });
        assert.strictEqual(signed.body.result.structuredContent.result, 'Bearer tok-person-0123456789', 'the person\'s own sign-in goes to an OpenVibe site');
        const refused = await call('openvibe_execute', { code: 'try { await tools.deals_deals_alert({ product: "tv" }); } catch (e) { return e.message; }' });
        assert.strictEqual(refused.structuredContent.result, 'Sign in to make an alert', 'a site\'s refusal is the script\'s error');
        const none = await call('openvibe_execute', { code: 'return typeof tools.casino_anything;' });
        assert.strictEqual(none.structuredContent.result, 'undefined');
        assert.strictEqual((await call('openvibe_execute', {})).isError, true, 'no code: said');
        console.log('network mcp: ok');
    } finally {
        server.close();
    }
})().catch((e) => { console.error(e); process.exit(1); });
