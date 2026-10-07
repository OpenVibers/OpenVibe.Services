'use strict';
/**
 * The two in-process stubs every Services test runs against (no real Network, no real authority):
 *
 *   startNetwork()    OpenVibe.Network: the JWKS the app's key provider loads, the OAuth token endpoint
 *                     (grant_type=client_credentials) with EVERY mint recorded — so a test can prove
 *                     Services mints one token per authority audience and reuses it — and
 *                     GET /api/v1/projects/:project, the membership answer the person-facing path asks
 *                     (200 for a member, 404 like Network for everyone else).
 *
 *   startAuthority()  one authority's resource API: GET /api/v1/resources?project=&kind=&cursor=&limit=
 *                     (common.resource-list-result@1, paged) and GET /api/v1/resources/:ovrn
 *                     (common.resource-summary@1 or 404). `hang`, `status` and `latencyMs` make it slow,
 *                     refusing or unreachable, and `calls` records every request it received (path,
 *                     query, Authorization) so a test can see which authority was asked what.
 *
 * Fixtures are built with the one formatter (contracts.resources.format): every summary carries a valid
 * OVRN, so what the stubs answer is what a real authority would.
 */
const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { serviceAuth, ids, resources: resourceNames } = require('openvibe-contracts');

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const b64url = (s) => Buffer.from(JSON.stringify(s)).toString('base64url');
const unb64url = (s) => { try { return JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8')); } catch { return null; } };
const problem = (res, status, code, detail) => {
    res.writeHead(status, { 'Content-Type': 'application/problem+json' });
    res.end(JSON.stringify({ type: `https://openvibe.network/problems/${code}`, title: code, status, code, detail }));
};
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b)); });

/** A common.resource-summary@1 with a valid OVRN (built by the one formatter). `kind` is `<service>.<type>`. */
function summary({ service, kind, project, id = ids.newId('watch'), state = 'active', name, created_at }) {
    return {
        id, kind, service, project_id: project, state,
        name: name || `${kind} ${id.slice(-6)}`,
        created_at: created_at || new Date(Date.parse('2026-01-01T00:00:00Z')).toISOString(),
        ovrn: resourceNames.format({ service, project_id: project, type: kind.split('.')[1], id }),
    };
}

/**
 * OpenVibe.Network as the two routes Services uses, plus the project-membership answer.
 * `failTokens` makes the token endpoint refuse (5xx): the JWKS still loads and incoming tokens still
 * verify, so a test can watch the authority tokens fail alone.
 */
async function startNetwork({ failTokens = false } = {}) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const issuer = 'http://network.test';
    const mints = [];                 // every client_credentials grant: { audience, scope, client_id }
    const members = new Map();         // project -> Set of subject ids
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://network.test');
        if (url.pathname === '/api/.well-known/jwks') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ keys: [{ kty: 'RSA', kid: 'n1', ...publicKey.export({ format: 'jwk' }) }], public_key: publicPem }));
        }
        if (url.pathname === '/oauth/token' && req.method === 'POST') {
            const form = new URLSearchParams(await readBody(req));
            if (failTokens) return problem(res, 503, 'oauth.unavailable', 'the token endpoint is down');
            const audience = form.get('audience');
            const scope = form.get('scope') || '';
            mints.push({ audience, scope, client_id: form.get('client_id') });
            if (form.get('grant_type') !== 'client_credentials' || form.get('client_secret') !== 'services-secret') {
                return problem(res, 401, 'oauth.invalid_client', 'not Services');
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ access_token: `svc-token:${audience}:${mints.filter((m) => m.audience === audience).length}`, token_type: 'Bearer', expires_in: 300, scope }));
        }
        if (url.pathname.startsWith('/api/v1/projects/') && req.method === 'GET') {
            const project = decodeURIComponent(url.pathname.slice('/api/v1/projects/'.length));
            const payload = unb64url(String(req.headers.authorization || '').replace(/^Bearer /, '').split('.')[1]);
            const subject = payload && payload.subject_id;
            const mine = members.get(project);
            if (subject && mine && mine.has(subject)) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ project: { id: project, name: 'stub', owner: { type: 'user', id: subject } } }));
            }
            return problem(res, 404, 'project.not_found', `no project ${project} for this caller`);
        }
        return problem(res, 404, 'route.not_found', url.pathname);
    });
    const url = await listen(server);
    return {
        url, issuer, publicPem, privatePem, mints, members,
        /** A Network service token (identity.service-token-claims@1) for audience openvibe.services. */
        signService({ sub = 'svc:console', aud = ['openvibe.services'], cap = ['services.resource.read'], project_id, actor_type = 'service', env, on_behalf_of, expSec = 300 } = {}) {
            const now = Math.floor(Date.now() / 1000);
            return serviceAuth.signServiceToken({
                iss: issuer, sub, actor_type, aud, cap, iat: now, exp: now + expSec, jti: crypto.randomBytes(8).toString('hex'),
                ...(project_id ? { project_id } : {}), ...(env ? { env } : {}), ...(on_behalf_of ? { on_behalf_of } : {}),
            }, privatePem);
        },
        /** A person's Network user token (a user token names no capability and no project). */
        signUser({ subject = ids.newId('user'), username = 'ada', role = 'user' } = {}) {
            return jwt.sign({ sub: String(Date.parse('2026-01-01T00:00:00Z')), subject_id: subject, username, display_name: username, role }, privatePem, { algorithm: 'RS256', issuer, expiresIn: '1h' });
        },
        /** Add `subject` as a member of `project` (what Network's developer API answers 200 for). */
        addMember(project, subject) { if (!members.has(project)) members.set(project, new Set()); members.get(project).add(subject); },
        mintsFor: (audience) => mints.filter((m) => m.audience === audience),
        close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
    };
}

/**
 * One authority's resource index (server/authorities/adapter.js talks to exactly these two routes).
 * `ignoreProject` makes it answer every project's rows whatever `?project=` says — a non-conforming
 * authority, so a test can prove Services still keeps a scoped read scoped.
 */
async function startAuthority({ id, resources = [], hang = false, status = null, latencyMs = 0, ignoreProject = false } = {}) {
    const calls = [];
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://authority.test');
        calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), authorization: req.headers.authorization || null });
        if (hang) return;                                        // never answers: the caller's timeout must decide
        if (status) return problem(res, status, 'authority.refused', `${id} refuses`);
        if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
        if (req.method === 'GET' && url.pathname === '/api/v1/resources') {
            const project = url.searchParams.get('project');
            const kind = url.searchParams.get('kind');
            const limit = Number(url.searchParams.get('limit') || 100);
            const offset = Number(unb64url(url.searchParams.get('cursor')) || 0);
            const scoped = ignoreProject ? null : project;
            const rows = resources.filter((r) => (!scoped || r.project_id === scoped) && (!kind || r.kind === kind));
            const page = rows.slice(offset, offset + limit);
            const nextOffset = offset + page.length;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ resources: page, next_cursor: nextOffset < rows.length ? b64url(nextOffset) : null }));
        }
        if (req.method === 'GET' && url.pathname.startsWith('/api/v1/resources/')) {
            const ovrn = decodeURIComponent(url.pathname.slice('/api/v1/resources/'.length));
            const hit = resources.find((r) => r.ovrn === ovrn);
            if (!hit) return problem(res, 404, 'resources.unknown_resource', `no resource named ${ovrn}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(hit));
        }
        return problem(res, 404, 'route.not_found', url.pathname);
    });
    const url = await listen(server);
    return {
        id, url, calls, resources,
        /** The registry entry the app is given in place of a manifest-derived authority. */
        descriptor: {
            id, name: `Stub ${id}`, internalOrigin: url, publicOrigin: `https://${id}.test`,
            audience: `openvibe.${id}`, capability: `${id}.resource.read`, manifestVersion: '0.0.1',
            contractsRange: null, status: 'alpha',
        },
        close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
    };
}

/** The authority registry shape server/authorities/index.js returns, over stubs (or descriptors). */
function registryOf(entries) {
    const byId = new Map(entries.map((e) => [e.id, e.descriptor || e]));
    return { list: () => [...byId.values()], get: (id) => byId.get(id) || null, ids: () => [...byId.keys()], size: () => byId.size };
}

module.exports = { startNetwork, startAuthority, registryOf, summary };
