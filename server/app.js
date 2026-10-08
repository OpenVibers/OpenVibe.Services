'use strict';

/**
 * OpenVibe.Services — the developer platform (ADR-048, plan T13; the developer portal moved here from OpenVibe.Codes
 * on 2026-10-08). Express app factory; server/index.js listens and starts the background work, tests build their
 * own instance with a temp database, an injectable clock and mock neighbours. Nothing starts at module load.
 *
 *   /                 landing, policy, public release pages, staff trust (http/pages.js)
 *   /docs             generated reference (http/docs.js)
 *   /oauth, /tools/webhooks, /manifests/validate   developer tools (http/tools.js)
 *   /projects         the signed-in console over Network's projects API (http/portal.js)
 *   /releases/:id/*   release actions (http/portal.js)
 *   /api/v1/resources, /api/v1/authorities   the merged resource index over every authority (api/v1.js)
 *   /api/v1           the release API and the docs' JSON (http/api.js)
 *   /auth/*           Network SSO with PKCE (auth/sso.js)
 *   /api/health, /api/ready, /release.json, /metrics (loopback only)
 *
 * createApp({ config, store, now, fetchImpl, log, keys, membership, authorities, tokens, index, registry,
 *             limitsNow, actorLimits, indexnow, valkey }) → { app, ctx }
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');
const cache = require('openvibe-shared/cache-policy');
const { createRegistry, instrument } = require('openvibe-shared/metrics');

const { loadConfig } = require('./config');
const { openDb, migrate, createStore } = require('./db');
const { createKeyStore } = require('./auth/keys');
const { createSso } = require('./auth/sso');
const { createApiAuth } = require('./auth/api');
const { createUserAuth, createMembership } = require('./network');
const { createNetworkClient } = require('./clients/network');
const { createServicesOutbox } = require('./events/outbox');
const { createAuthorities } = require('./authorities');
const { createAuthorityTokens } = require('./authorities/tokens');
const { createResourceIndexService } = require('./resources');
const { createSelfAuthority } = require('./registry/self-authority');
const { v1Router } = require('./api/v1');
const { generate } = require('./docs/generate');
const { createTrust } = require('./domain/trust');
const { createReleases } = require('./domain/releases');
const { createPlayground } = require('./domain/playground');
const { createArchiver } = require('./domain/project-archive');
const { createLimitsReader } = require('./domain/limits');
const { createDocsRoutes } = require('./http/docs');
const { createToolRoutes } = require('./http/tools');
const { createPageRoutes } = require('./http/pages');
const { createPortalRoutes, createReleaseActionRoutes } = require('./http/portal');
const { createApi } = require('./http/api');
const { createServicesReadiness, registerServicesGauges } = require('./observability');
const { createActorLimits } = require('./http/actor-limits');
const { createIndexNow } = require('openvibe-shared/indexnow');
const { assetVersion, send } = require('./render/layout');
const { html } = require('./render/html');
const { ServiceError } = require('./util');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;
// The resource index takes query strings; nothing there uploads.
const INDEX_JSON_LIMIT = '64kb';

async function createApp(opts = {}) {
    const config = opts.config || loadConfig();
    const log = opts.log || console;
    const fetchImpl = opts.fetchImpl;
    const registry = opts.registry || createRegistry();
    // PostgreSQL (ADR-035): opened and migrated here unless the caller (a test, server/index.js) hands in a store.
    let store = opts.store;
    if (!store) {
        const db = openDb(config, { registry, log });
        await migrate(config, { serving: db, log });
        store = createStore(db, { now: opts.now });
    }

    const docs = generate({ now: store.now });
    const keys = opts.keys || createKeyStore({ config, fetchImpl: fetchImpl || globalThis.fetch, log });
    const sso = createSso({ config, keys, fetchImpl: fetchImpl || globalThis.fetch, now: store.now, log });
    const network = createNetworkClient({ config, fetchImpl, log });
    const outbox = createServicesOutbox({ db: store.db, config, fetchImpl, now: store.now, log });
    const trust = createTrust({ store, outbox });
    // IndexNow (openvibe-shared/indexnow): created once at boot from INDEXNOW_KEY. Unset → off, nothing
    // mounted, nothing sent; tests and drills never set it.
    const indexnow = opts.indexnow !== undefined ? opts.indexnow : createIndexNow({
        host: config.baseUrl, key: config.indexnow.key, ...(fetchImpl ? { fetch: fetchImpl } : {}), log,
    });
    const releases = createReleases({ store, outbox, trust, config, indexnow });
    const playground = createPlayground({ store, config, network, keys, fetchImpl, log });
    const archiver = createArchiver({ config, fetchImpl, log });
    // Each enforcing service's /limits.json, for /docs/limits and the project usage page.
    const limits = createLimitsReader();

    // The merged resource index: every authority the pinned contracts name, read over HTTP with a token minted
    // for its audience, plus Services' own manifests and releases read in process.
    const authorities = opts.authorities || createAuthorities(config, { log });
    const tokens = opts.tokens || createAuthorityTokens(config, { authorities, fetchImpl: fetchImpl || globalThis.fetch });
    const index = opts.index || createResourceIndexService({ config, authorities, tokens, self: createSelfAuthority({ store }), fetchImpl: fetchImpl || globalThis.fetch, log });
    const userAuth = createUserAuth(config, keys);
    const membership = opts.membership || createMembership(config, { fetchImpl: fetchImpl || globalThis.fetch });
    const apiAuth = createApiAuth({ config, keys, userAuth, membership });

    const ctx = { config, store, docs, keys, sso, network, outbox, trust, releases, playground, archiver, limits, indexnow, authorities, tokens, index, apiAuth, log };

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    const release = require('openvibe-shared/release').createRelease({ service: 'services', root: path.join(__dirname, '..') });
    require('./render/layout').setRelease(release.release);
    registerServicesGauges(registry, { authorities });
    const metrics = instrument(app, { service: 'services', release: release.release, registry });
    app.locals.metrics = metrics.registry;
    app.locals.ctx = ctx;
    // Per-actor limits (http/actor-limits.js) at /api/v1, the console, release actions and the tools'
    // forms, counted once the caller is known; the per-address limits below stay.
    // Valkey (ADR-035): shared, never-authoritative state (per-actor limit counters). Optional.
    const valkey = opts.valkey !== undefined ? opts.valkey : (config.valkey.url ? require('openvibe-sdk/valkey').createValkey({ url: config.valkey.url, prefix: config.valkey.prefix, log }) : null);
    ctx.valkey = valkey;
    ctx.actorLimits = createActorLimits({ config, now: opts.limitsNow || (() => Date.now()), registry: metrics.registry, log, enabled: opts.actorLimits !== false, valkey });

    app.use(contracts.http.middleware());
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                // The OpenVibe Frame (theme-loader, navbar, footer) comes from the Network; the inline init is ours.
                // Cloudflare Web Analytics: Cloudflare injects its beacon at the edge and the privacy text says it may
                // measure performance; script-src loads the beacon, connect-src is where it reports.
                scriptSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://static.cloudflareinsights.com'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
                fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
                imgSrc: ["'self'", 'data:', 'https://openvibe.network', 'https://openvibe.media'],
                // openvibe.events: release notifications (release-watch's EventSource, openvibe-shared 1.17).
                connectSrc: ["'self'", 'https://openvibe.network', 'https://cloudflareinsights.com', 'https://openvibe.events'],
                frameSrc: ["'self'", 'https://openvibe.network'],
                frameAncestors: ["'none'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'", 'https://openvibe.network'],
            },
        },
        frameguard: { action: 'deny' },
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'same-site' },
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }));
    app.use(cookieParser());

    // ── Machine endpoints ───────────────────────────────────
    // Liveness: the process answers. What it can and cannot do is /api/ready's job.
    app.get('/api/health', (req, res, next) => outbox.status().then((events) => res.json({
        status: 'ok', service: 'services', version: VERSION, authorities: authorities.size(), events,
    }), next));
    // GET /release.json (ADR-016) and POST /release-metrics: open tabs' update reports into /metrics.
    release.mount(app, { registry: metrics.registry });
    const readiness = createServicesReadiness({ store, network, outbox, docs, config, authorities, release: release.release, valkey: ctx.valkey });
    app.get('/api/ready', readiness.handler);

    // ── The merged resource index (ADR-048: services.resource.read) ──
    // Its own auth (a service token, or a person's token scoped to one project) and JSON-only answers; mounted
    // before the session middleware and the release API, so nothing of the browser side applies to it.
    const kernel = express.Router();
    kernel.use(
        // A per-address cap: the fan-out reaches every authority, so a caller loop here is every
        // authority's load too; a refusal is an RFC 9457 problem like every other answer, never text.
        rateLimit({
            windowMs: 60_000, max: 240, standardHeaders: true, legacyHeaders: false,
            handler: (req, res) => contracts.http.sendProblem(res, 429, 'services.rate_limited', { detail: 'too many requests from this address; retry shortly', ctx: req.ov }),
        }),
        express.json({ limit: INDEX_JSON_LIMIT }),
        (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); },
        apiAuth.middleware,
        v1Router({ config, apiAuth, index, authorities }));
    app.use('/api/v1', (req, res, next) => (/^\/(resources|authorities)(\/|$)/.test(req.path) ? kernel(req, res, next) : next()));

    // ── Who is asking (verified offline; refreshed when expired) ──
    app.use(sso.middleware());

    // ── Sign-in (OAuth2 + PKCE client of OpenVibe.Network) ──
    app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));
    app.use('/auth', sso.routes());
    { const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'services', service: 'services', host: 'openvibe.services', name: 'OpenVibe.Services', profile: 'ugc' })); }

    // GET /<key>.txt — the IndexNow key file (mounted only when a key is configured; it serves itself).
    if (indexnow.enabled) app.use(indexnow.keyFile);

    // ── Static assets (content-hashed ?v= → immutable) ──────
    // This site's own pinned copy of the OpenVibe Frame's browser files (openvibe-shared/serve).
    app.use('/shared', require('openvibe-shared/serve').handler());
    app.use(express.static(PUBLIC_DIR, {
        index: false, redirect: false,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', cache.assetHeaders(rel, { hashed: !!v && v === assetVersion(rel) }));
        },
    }));

    // ── API ─────────────────────────────────────────────────
    app.use('/api/v1', createApi(ctx));
    app.use('/api', (req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'No such API route', ctx: req.ov }));

    // ── Pages ───────────────────────────────────────────────
    app.use(rateLimit({ windowMs: 60_000, limit: Number(process.env.SERVICES_RATE_LIMIT_PER_MIN) || 300, standardHeaders: true, legacyHeaders: false }));   // per address; tests raise it
    app.use('/docs', createDocsRoutes(ctx));
    app.use('/projects', rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false, skip: (req) => req.method === 'GET' }), createPortalRoutes(ctx));
    app.use('/releases', createReleaseActionRoutes(ctx));
    app.use(createToolRoutes(ctx));
    app.use(createPageRoutes(ctx));
    app.use((req, res) => send(res, 404, { viewer: req.viewer, config, path: req.originalUrl, title: 'Not found', body: html`<h1>Not found</h1><p>No page here. Try the <a href="/docs">docs</a> or <a href="/projects">your projects</a>.</p>` }));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        if (res.headersSent) return;
        if (req.path.startsWith('/api/')) {
            if (err && err.type === 'entity.parse.failed') return contracts.http.sendProblem(res, 400, 'request.malformed_json', { ctx: req.ov });
            if (err && err.type === 'entity.too.large') return contracts.http.sendProblem(res, 413, 'request.too_large', { ctx: req.ov });
            if (err instanceof ServiceError) return contracts.http.sendProblem(res, err.status, err.code, { detail: err.detail, ctx: req.ov, extra: err.extra });
        }
        // Never log request bodies: forms here carry secrets.
        log.error('[Services]', err && err.message ? err.message.slice(0, 300) : err);
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (req.path.startsWith('/api/')) return contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx: req.ov });
        if (err && err.type === 'entity.too.large') return res.status(413).type('text/plain').send('That form was too large.');
        res.status(500).type('text/plain').send('Something went wrong on our side. Try again in a moment.');
    });

    return { app, ctx };
}

module.exports = { createApp, VERSION, INDEX_JSON_LIMIT };
