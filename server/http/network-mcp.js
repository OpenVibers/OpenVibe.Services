'use strict';
/**
 * POST /mcp: the OpenVibe network as one read-only MCP server (AGT-2). Revision 2025-06-18, Streamable HTTP, stateless:
 * one JSON-RPC 2.0 request (or a batch) answered once as JSON, no sessions.
 *
 *   openvibe_sites        every open site of the network: id, name, purpose, home, API, OpenAPI document, docs and MCP,
 *                         as each site's own /.well-known/agent.json says
 *   openvibe_operations   { site } → the site's documented GET operations, from its /openapi.json: path, summary, the
 *                         path and query parameters
 *   openvibe_get          { site, path, query? } → one documented GET operation, called anonymously: status, content
 *                         type and body (JSON when it is JSON), cut at 256 KB
 *
 * What keeps it safe:
 *   - The sites are the Network frame's list (https origins only); a site is named by its id or host, never a URL.
 *   - A call is a GET of a path that matches one of the site's documented GET operations (its {params} filled with
 *     one path segment each), on that site's own origin. No other method, host or path.
 *   - It carries no credential: no cookie, no Authorization, nothing of the caller's. What it reads is what anyone
 *     reads. A redirect is reported, not followed.
 *   - Bounded: 15 s and 256 KB a call, 20 query keys of at most 500 characters, and the endpoint's own per-address limit
 *     (60 a minute, server/app.js). The frame, the manifests and the documents are cached for an hour.
 *   - A tool error is a result the caller can read (isError), per MCP; a bad message is a JSON-RPC error.
 */
const express = require('express');
const pkg = require('../../package.json');

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);
const CACHE_MS = 60 * 60 * 1000;
const CALL_TIMEOUT_MS = 15_000;
const MAX_BODY = 256 * 1024;
const MAX_TEXT = 20_000;
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];

const TOOLS = [
    {
        name: 'openvibe_sites',
        title: 'OpenVibe sites',
        description: 'List every open site of the OpenVibe network with what it is for and where its API, OpenAPI document, docs and MCP server are. Use a site\'s id with openvibe_operations and openvibe_get.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
        name: 'openvibe_operations',
        title: 'A site\'s operations',
        description: 'List the GET operations one OpenVibe site documents in its OpenAPI document: path template, summary, path and query parameters.',
        inputSchema: { type: 'object', properties: { site: { type: 'string', description: 'A site id or host from openvibe_sites, e.g. "deals" or "openvibe.deals"' } }, required: ['site'], additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
        name: 'openvibe_get',
        title: 'Read from a site',
        description: 'Call one documented GET operation of an OpenVibe site, anonymously (public data only). The path must match a path template from openvibe_operations, with each {parameter} filled.',
        inputSchema: {
            type: 'object',
            properties: {
                site: { type: 'string', description: 'A site id or host from openvibe_sites' },
                path: { type: 'string', description: 'The full path, e.g. /api/v1/deals/hot or /api/v1/games/blackjack' },
                query: { type: 'object', description: 'Query parameters (strings, numbers or booleans)', additionalProperties: { type: ['string', 'number', 'boolean'] } },
            },
            required: ['site', 'path'],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
];

const INSTRUCTIONS = 'Read the OpenVibe network: openvibe_sites lists the sites, openvibe_operations lists one site\'s documented GET operations, and openvibe_get calls one of them anonymously. Only public data is reachable; nothing is written.';

const result = (id, value) => ({ jsonrpc: '2.0', id, result: value });
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const validId = (id) => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
const toolText = (value) => { const s = JSON.stringify(value, null, 2); return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n… (cut; the whole answer is in structuredContent)` : s; };
const fail = (id, message) => result(id, { content: [{ type: 'text', text: message }], isError: true });

function createNetworkMcp({ config, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console } = {}) {
    const networkUrl = String((config && config.network && config.network.url) || 'https://openvibe.network').replace(/\/+$/, '');
    const cache = new Map();   // key → { at, value }

    async function cached(key, load) {
        const hit = cache.get(key);
        if (hit && now() - hit.at < CACHE_MS) return hit.value;
        try {
            const value = await load();
            cache.set(key, { at: now(), value });
            return value;
        } catch (err) {
            if (hit) return hit.value;   // the last good answer outlives a failed refresh
            throw err;
        }
    }

    async function getJson(url, ms = 8000) {
        const r = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': 'OpenVibe network MCP (openvibe.services)' }, redirect: 'manual', signal: AbortSignal.timeout(ms) });
        if (r.status !== 200) throw new Error(`${new URL(url).host} answered ${r.status}`);
        return await r.json();
    }

    /** The network's open sites: origin by id and by host. */
    const sites = () => cached('sites', async () => {
        const frame = await getJson(`${networkUrl}/api/frame`);
        const origins = [...new Set((frame.nav || []).map((x) => x && x.url).filter((u) => typeof u === 'string' && /^https:\/\/[^/]+/.test(u)).map((u) => new URL(u).origin))].sort();
        const list = await Promise.all(origins.map(async (origin) => {
            let m = null;
            try { m = await getJson(`${origin}/.well-known/agent.json`); } catch { /* a site without a manifest is still listed */ }
            const host = new URL(origin).host;
            const sameOrigin = (u) => { try { return u && new URL(u, origin).origin === origin ? new URL(u, origin).href : null; } catch { return null; } };
            return {
                id: (m && typeof m.id === 'string' && m.id) || host, host, origin,
                name: (m && m.name) || host, purpose: (m && m.purpose) || null,
                api: sameOrigin(m && m.api), openapi: sameOrigin(m && m.openapi) || `${origin}/openapi.json`,
                docs: (m && m.docs) || null, mcp: (m && m.mcp && m.mcp.url) || null,
            };
        }));
        return list;
    });

    async function siteOf(name) {
        const key = String(name || '').trim().toLowerCase();
        if (!key) return null;
        return (await sites()).find((s) => s.id.toLowerCase() === key || s.host === key) || null;
    }

    /** A site's documented GET operations, with each one's full path (the document's server path prefix included). */
    const operations = (site) => cached(`ops:${site.origin}`, async () => {
        const doc = await getJson(site.openapi, 10000);
        let prefix = '';
        const server = Array.isArray(doc.servers) && doc.servers[0] && doc.servers[0].url;
        if (server) {
            try {
                const u = new URL(server, site.origin);
                if (u.origin === site.origin) prefix = u.pathname.replace(/\/+$/, '');
            } catch { /* a relative or odd server URL: the paths stand alone */ }
        }
        const ops = [];
        for (const [p, item] of Object.entries(doc.paths || {})) {
            const op = item && item.get;
            if (!op) continue;
            const vis = [].concat(op['x-openvibe-visibility'] || []);
            if (vis.length && vis.every((v) => v === 'internal')) continue;
            const params = [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(op.parameters) ? op.parameters : [])];
            const full = `${prefix}${p.startsWith('/') ? p : `/${p}`}`;
            ops.push({
                path: full, summary: op.summary || op.description || null,
                path_params: [...full.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]),
                query_params: params.filter((q) => q && q.in === 'query' && q.name).map((q) => q.name),
            });
        }
        ops.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        return ops;
    });

    /** The documented operation a concrete path matches, or null: an exact path before a template, fewer {params} first. */
    function matchOperation(ops, path) {
        for (const op of [...ops].sort((a, b) => a.path_params.length - b.path_params.length)) {
            const re = new RegExp(`^${op.path.split(/\{[^}]+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/?#]+')}$`);
            if (re.test(path)) return op;
        }
        return null;
    }

    async function readCapped(r) {
        const reader = r.body && r.body.getReader ? r.body.getReader() : null;
        if (!reader) { const t = await r.text(); return { text: t.slice(0, MAX_BODY), truncated: t.length > MAX_BODY }; }
        const chunks = []; let size = 0; let truncated = false;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > MAX_BODY) { chunks.push(value.slice(0, value.length - (size - MAX_BODY))); truncated = true; await reader.cancel().catch(() => {}); break; }
            chunks.push(value);
        }
        return { text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'), truncated };
    }

    async function callGet(args) {
        const site = await siteOf(args.site);
        if (!site) return { error: `No open OpenVibe site is called "${String(args.site || '').slice(0, 80)}": see openvibe_sites.` };
        const path = String(args.path || '');
        if (!/^\/[^?#\s\\]*$/.test(path) || /(^|\/)\.\.?(\/|$)/.test(path) || /%2e|%2f|%5c/i.test(path)) return { error: 'The path is one absolute path with no query, no fragment and no dot segments.' };
        const ops = await operations(site);
        const op = matchOperation(ops, path);
        if (!op) return { error: `${site.id} documents no GET operation at ${path.slice(0, 200)}: see openvibe_operations.` };
        const q = args.query == null ? {} : args.query;
        if (typeof q !== 'object' || Array.isArray(q)) return { error: 'query is an object of strings, numbers or booleans.' };
        const entries = Object.entries(q);
        if (entries.length > 20) return { error: 'At most 20 query parameters.' };
        const search = new URLSearchParams();
        for (const [k, v] of entries) {
            if (!/^[A-Za-z0-9_.\-[\]]{1,64}$/.test(k) || !['string', 'number', 'boolean'].includes(typeof v) || String(v).length > 500) return { error: `The query parameter "${k.slice(0, 64)}" is not a short string, number or boolean.` };
            search.append(k, String(v));
        }
        const url = `${site.origin}${path}${entries.length ? `?${search}` : ''}`;
        let r;
        try {
            r = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json, text/plain;q=0.8, */*;q=0.1', 'User-Agent': 'OpenVibe network MCP (openvibe.services)' }, redirect: 'manual', signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
        } catch (err) {
            return { error: `${site.id} did not answer (${err && err.name === 'TimeoutError' ? 'it took more than 15 s' : 'the connection failed'}).` };
        }
        const type = String(r.headers.get('content-type') || '');
        if (r.status >= 300 && r.status < 400) return { value: { site: site.id, url, status: r.status, location: r.headers.get('location') || null } };
        const { text, truncated } = await readCapped(r);
        let body = text;
        if (/json/i.test(type) && !truncated) { try { body = JSON.parse(text); } catch { /* the text stands */ } }
        return { value: { site: site.id, url, operation: op.path, status: r.status, content_type: type || null, truncated, body } };
    }

    async function callTool(id, params) {
        const name = params.name;
        const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
        try {
            if (name === 'openvibe_sites') {
                const list = (await sites()).map(({ origin, ...s }) => s);
                return result(id, { content: [{ type: 'text', text: toolText(list) }], structuredContent: { sites: list }, isError: false });
            }
            if (name === 'openvibe_operations') {
                const site = await siteOf(args.site);
                if (!site) return fail(id, `No open OpenVibe site is called "${String(args.site || '').slice(0, 80)}": see openvibe_sites.`);
                const ops = await operations(site);
                const value = { site: site.id, openapi: site.openapi, operations: ops };
                return result(id, { content: [{ type: 'text', text: toolText(value) }], structuredContent: value, isError: false });
            }
            if (name === 'openvibe_get') {
                const out = await callGet(args);
                if (out.error) return fail(id, out.error);
                return result(id, { content: [{ type: 'text', text: toolText(out.value) }], structuredContent: out.value, isError: out.value.status >= 400 });
            }
        } catch (err) {
            log.warn && log.warn(`[network-mcp] ${name}: ${String((err && err.message) || err).slice(0, 200)}`);
            return fail(id, 'The network could not be read just now; try again in a minute.');
        }
        return error(id, -32602, 'Unknown tool');
    }

    async function handleMessage(msg) {
        if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return error(null, -32600, 'Invalid Request');
        const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
        if (hasId && !validId(msg.id)) return error(null, -32600, 'Invalid Request');
        if (!hasId || msg.method.startsWith('notifications/')) return null;   // a notification has no answer
        const params = msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params) ? msg.params : {};
        switch (msg.method) {
            case 'initialize':
                return result(msg.id, {
                    protocolVersion: SUPPORTED_VERSIONS.has(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSION,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: 'openvibe-network', title: 'The OpenVibe network', version: pkg.version },
                    instructions: INSTRUCTIONS,
                });
            case 'ping': return result(msg.id, {});
            case 'tools/list': return result(msg.id, { tools: TOOLS });
            case 'tools/call': return await callTool(msg.id, params);
            default: return error(msg.id, -32601, 'Method not found');
        }
    }

    const router = express.Router();
    const json = express.json({ limit: '64kb', type: ['application/json', 'application/*+json'], strict: false });
    // MCP clients in a browser exist: anonymous only, so `*` gives nothing away.
    router.use('/mcp', (_req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cache-Control', 'no-store'); next(); });
    router.options('/mcp', (_req, res) => {
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Protocol-Version');
        res.setHeader('Access-Control-Max-Age', '600');
        res.status(204).end();
    });
    router.get('/mcp', (_req, res) => res.set('Allow', 'POST, OPTIONS').status(405).json(error(null, -32000, 'POST a JSON-RPC message; this server streams nothing')));
    router.post('/mcp', json, async (req, res, next) => {
        try {
            const version = req.get('mcp-protocol-version');
            if (version && !SUPPORTED_VERSIONS.has(version)) return res.status(400).json(error(null, -32600, 'Unsupported protocol version'));
            const body = req.body;
            if (!body || typeof body !== 'object' || (Array.isArray(body) && !body.length)) return res.json(error(null, -32600, 'Invalid Request'));
            if (Array.isArray(body) && body.length > 20) return res.json(error(null, -32600, 'At most 20 messages in a batch'));
            const answers = [];
            for (const msg of Array.isArray(body) ? body : [body]) {
                const a = await handleMessage(msg);
                if (a) answers.push(a);
            }
            if (!answers.length) return res.status(202).end();
            return res.json(Array.isArray(body) ? answers : answers[0]);
        } catch (err) { return next(err); }
    });
    return router;
}

module.exports = { createNetworkMcp, TOOLS };
