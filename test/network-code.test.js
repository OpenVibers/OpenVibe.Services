'use strict';
// The network's tools in two (server/http/network-code.js): a site's MCP on its own origin or another OpenVibe host is
// offered (openvibe.compare names Bench's, bench.openvibe.services), one MCP two sites name is read once, and a foreign
// host is never asked.
//   node test/network-code.test.js
const assert = require('assert');
const { createNetworkCode } = require('../server/http/network-code');

(async () => {
    const asked = [];
    const fetchImpl = async (url, opts) => {
        asked.push(String(url));
        const m = JSON.parse(opts.body);
        if (String(url) === 'https://bench.openvibe.services/mcp' && m.method === 'tools/list') {
            return new Response(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'bench_leaderboard', description: 'The models ranked by blind votes.', inputSchema: { type: 'object', properties: { kind: { type: 'string' } } } }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('{}', { status: 404 });
    };
    const sites = async () => [
        { id: 'compare', name: 'OpenVibe.Compare', host: 'openvibe.compare', origin: 'https://openvibe.compare', mcp: 'https://bench.openvibe.services/mcp' },
        { id: 'bench', name: 'OpenVibe.Bench', host: 'bench.openvibe.services', origin: 'https://bench.openvibe.services', mcp: '/mcp' },
        { id: 'elsewhere', name: 'Elsewhere', host: 'x.example', origin: 'https://x.example', mcp: 'https://evil.example/mcp' },
        { id: 'plain', name: 'Plain', host: 'openvibe.plain', origin: 'https://openvibe.plain', mcp: 'http://openvibe.other/mcp' },
    ];
    const code = createNetworkCode({ sites, cached: (_k, load) => load(), fetchImpl });
    const all = await code.index();
    assert.deepStrictEqual(all.map((x) => [x.site, x.js]), [['compare', 'compare_bench_leaderboard']], 'Bench\'s MCP offered once, under the first site that names it');
    assert.deepStrictEqual(asked, ['https://bench.openvibe.services/mcp'], 'a foreign host and a plain-http MCP are never asked');
    console.log('network code: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
