'use strict';
/**
 * The network's tools in two (plan §AD.26 step 2; the owner sent Cloudflare's "2,600 tools in 2" on 2026-11-17: "Analyze
 * and use to improve openvibe"). Every OpenVibe site's own MCP tools, reached through this one server:
 *
 *   openvibe_search  { query, limit? }  the tools across the network that fit, each as a typed signature
 *                                        (`tools.design_openvibe_design_audit_page(input: { url: string }): Promise<any>`)
 *   openvibe_execute { code }           JavaScript that calls them and returns only what it needs, in openvibe-sdk's
 *                                        code-mode sandbox (its own process under Node's permission model, no network,
 *                                        files or environment; 30 s, 30 calls, 8 KB back)
 *
 * so an agent connects once and reaches Design, Vision, Tools, Compare and every site that serves MCP, for a few hundred
 * tokens of tool list instead of every schema.
 *
 * What keeps it safe:
 *   - The tools are each site's own: its manifest's MCP address on its own https origin (or another openvibe.* host), from the Network frame's list
 *     of sites. A script names a tool, never a URL; this server's own MCP is left out.
 *   - A call is that site's tools/call, nothing else. The caller's own Bearer (when the MCP client sent one) goes only to
 *     an openvibe.* origin of that list, so each site decides what the person may do; with none, calls are anonymous.
 *   - One script at a time per caller, SCRIPTS_AT_ONCE on the server; each call 30 s and 256 KB at most.
 *
 *   createNetworkCode({ sites, cached, fetchImpl, runCode? })
 *     → { index(), search(query, limit), execute(code, { auth, caller }) }
 */
const codeMode = require('openvibe-sdk/code-mode');

const SCRIPTS_AT_ONCE = 4;
const CALL_TIMEOUT_MS = 30_000;
const MAX_BODY = 256 * 1024;
const MAX_TOOLS_A_SITE = 200;
const OURS = /^([a-z0-9-]+\.)*openvibe\.[a-z]{2,}$/i;
const BEARER = /^Bearer [A-Za-z0-9._~+/=-]{10,4096}$/;
const js = (s) => String(s).toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^([^a-z])/, 's_$1');

function parseRpc(raw) {
    const text = String(raw || '');
    const body = /^\s*(event|data):/.test(text) ? (text.split('\n').find((l) => l.startsWith('data:')) || '').slice(5) : text;
    return JSON.parse(body);
}

function createNetworkCode({ sites, cached, fetchImpl = globalThis.fetch, runCode = codeMode.runCode, selfHost = 'openvibe.services' } = {}) {
    const running = new Set();

    async function rpc(url, method, params, { auth = null, ms = 8000 } = {}) {
        const r = await fetchImpl(url, {
            method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(ms),
            headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'User-Agent': 'OpenVibe network MCP (openvibe.services)', ...(auth ? { Authorization: auth } : {}) },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        if (r.status !== 200) throw new Error(`${new URL(url).host} answered ${r.status}`);
        const len = Number(r.headers.get('content-length') || 0);
        if (len > MAX_BODY) throw new Error(`${new URL(url).host} answered more than ${MAX_BODY} bytes`);
        const text = await r.text();
        if (text.length > MAX_BODY) throw new Error(`${new URL(url).host} answered more than ${MAX_BODY} bytes`);
        return parseRpc(text);
    }

    /** Every site's MCP tools: { site, host, origin, mcp, tool, js, def } a tool, read anonymously, kept an hour. */
    const index = () => cached('code-index', async () => {
        const list = await sites();
        const out = [];
        const seen = new Set();
        await Promise.all(list.map(async (s) => {
            if (!s.mcp || s.host === selfHost) return;
            let mcpUrl;
            try { mcpUrl = new URL(s.mcp, s.origin); } catch { return; }
            // A site's MCP is on its own origin, or on another OpenVibe host (openvibe.compare names Bench's,
            // bench.openvibe.services); anything else is not offered. One MCP two sites name is read once.
            if (mcpUrl.origin !== s.origin && !(mcpUrl.protocol === 'https:' && OURS.test(mcpUrl.hostname))) return;
            if (seen.has(mcpUrl.href)) return;
            seen.add(mcpUrl.href);
            let tools = [];
            try { tools = ((await rpc(mcpUrl.href, 'tools/list', {})).result || {}).tools || []; } catch { return; }
            const site = js(String(s.id).replace(/^openvibe\./i, ''));
            for (const t of tools.slice(0, MAX_TOOLS_A_SITE)) {
                if (!t || typeof t.name !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(t.name)) continue;
                const name = `${site}_${js(t.name)}`;
                out.push({ site: s.id, host: s.host, origin: s.origin, mcp: mcpUrl.href, tool: t.name, js: name,
                    def: { name, description: `[${s.name || s.host}] ${String(t.description || '').slice(0, 400)}`, inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object' } } });
            }
        }));
        return out.sort((a, b) => a.js.localeCompare(b.js));
    });

    async function search(query, limit = 12) {
        const all = await index();
        const n = Math.max(1, Math.min(30, Number(limit) || 12));
        const found = codeMode.searchTools(all.map((x) => x.def), String(query || ''), n);
        return { tools: found.map((f) => { const x = all.find((y) => y.js === f.name); return { call: `tools.${f.name}`, site: x.site, tool: x.tool, signature: `tools.${f.signature}`, description: f.description }; }), total: all.length };
    }

    async function callOne(entry, input, auth) {
        const forward = auth && BEARER.test(auth) && OURS.test(entry.host) ? auth : null;
        let j;
        try { j = await rpc(entry.mcp, 'tools/call', { name: entry.tool, arguments: input || {} }, { auth: forward, ms: CALL_TIMEOUT_MS }); } catch (err) {
            return { ok: false, error: `${entry.site} did not answer: ${String((err && err.message) || err).slice(0, 160)}` };
        }
        if (j.error) return { ok: false, error: `${entry.site}: ${String(j.error.message || 'the call failed').slice(0, 300)}` };
        const res = j.result || {};
        const text = Array.isArray(res.content) ? res.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n') : '';
        if (res.isError) return { ok: false, error: text.slice(0, 400) || `${entry.site}: the tool failed` };
        if (res.structuredContent !== undefined) return { ok: true, value: res.structuredContent };
        try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: true, value: text }; }
    }

    async function execute(code, { auth = null, caller = 'anonymous' } = {}) {
        if (running.has(caller)) return { ok: false, error: 'one script at a time: your last one is still running' };
        if (running.size >= SCRIPTS_AT_ONCE) return { ok: false, error: 'the network runs a few scripts at once and is busy: try again in a moment' };
        running.add(caller);
        try {
            const all = await index();
            const byJs = new Map(all.map((x) => [x.js, x]));
            return await runCode(String(code || ''), {
                tools: all.map((x) => x.js),
                call: async (kind, name, input) => {
                    const entry = kind === 'tool' ? byJs.get(name) : null;
                    if (!entry) return { ok: false, error: `there is no tool ${name}: use openvibe_search` };
                    return callOne(entry, input, auth);
                },
            });
        } finally { running.delete(caller); }
    }

    return { index, search, execute };
}

module.exports = { createNetworkCode, SCRIPTS_AT_ONCE };
