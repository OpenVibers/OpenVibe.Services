'use strict';

/**
 * OpenVibe.Services — the resource control plane (ADR-048, plan T13). Express app factory;
 * server/index.js listens, tests build their own instance. Everything is injectable and nothing starts
 * at module load (the key refresher and the outbox relay start in server/index.js main()).
 *
 *   GET  /api/health, /api/ready, /release.json    liveness, truthful readiness, the release manifest
 *   GET  /metrics                                  direct loopback callers only (never proxied)
 *   /api/v1/*                                      the resource index (api/v1.js: one capability per route)
 *
 * createApp({ config, db, keys, userAuth, membership, authorities, tokens, index, outbox, registry,
 *             fetchImpl, now, log })
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { http } = require('openvibe-contracts');
const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { createKeyProvider, createUserAuth, createMembership } = require('./network');
const { createAuthorities } = require('./authorities');
const { createAuthorityTokens } = require('./authorities/tokens');
const { createResourceIndexService } = require('./resources');
const { createServicesOutbox } = require('./events/outbox');
const { createApiAuth } = require('./auth');
const { v1Router } = require('./api/v1');
const { createServicesReadiness, registerServicesGauges } = require('./observability');
const { ServiceError } = require('./util');
const { createRegistry, instrument } = require('openvibe-shared/metrics');

const VERSION = require('../package.json').version;
// The API takes query strings and (later) small JSON bodies; nothing here uploads.
const JSON_LIMIT = '64kb';

function createApp(opts = {}) {
    const config = opts.config || loadConfig();
    const db = opts.db || openDb(config);
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const log = opts.log || console;
    const now = opts.now || (() => Date.now());
    const keys = opts.keys || createKeyProvider(config, { fetchImpl, log });
    const userAuth = createUserAuth(config, keys);
    const membership = opts.membership || createMembership(config, { fetchImpl });
    const authorities = opts.authorities || createAuthorities(config, { log });
    const tokens = opts.tokens || createAuthorityTokens(config, { authorities, fetchImpl });
    const index = opts.index || createResourceIndexService({ config, authorities, tokens, fetchImpl, log });
    const outbox = opts.outbox || createServicesOutbox({ db, config, fetchImpl, now, log });
    const apiAuth = createApiAuth({ config, keys, userAuth, membership });
    const release = require('openvibe-shared/release').createRelease({ service: 'services', root: path.join(__dirname, '..') });

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    // Services answers JSON only for now (the console, plan T13 step 9, will widen this): helmet's
    // defaults carry what matters and there is no page yet whose CSP would need widening.
    app.use(helmet({ contentSecurityPolicy: false }));

    const registry = opts.registry || createRegistry();
    registerServicesGauges(registry, { authorities });
    const metrics = instrument(app, { service: 'services', release: release.release, registry });
    app.use(http.middleware());

    // Liveness: the process answers. What it can and cannot do is /api/ready's job, and the counts are
    // /metrics' and /api/ready's — this route says nothing it cannot back with a value it just read.
    app.get('/api/health', (req, res, next) => outbox.status().then((events) => res.json({
        ok: true, service: 'services', version: VERSION, authorities: authorities.size(), events,
    }), next));
    const readiness = createServicesReadiness({ db, keys, authorities, release: release.release });
    app.get('/api/ready', readiness.handler);
    release.mount(app, { registry: metrics.registry });

    app.use('/api/v1',
        // A per-address cap: the fan-out reaches every authority, so a caller loop here is every
        // authority's load too; a refusal is an RFC 9457 problem like every other answer, never text.
        rateLimit({
            windowMs: 60_000, max: 240, standardHeaders: true, legacyHeaders: false,
            handler: (req, res) => http.sendProblem(res, 429, 'services.rate_limited', { detail: 'too many requests from this address; retry shortly', ctx: req.ov }),
        }),
        express.json({ limit: JSON_LIMIT }),
        (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); },
        apiAuth.middleware,
        v1Router({ config, apiAuth, index, authorities }));

    // No page is served yet (the console is plan T13 step 9): every unknown route, page or API, is the
    // same problem+json.
    app.use((req, res) => http.sendProblem(res, 404, 'route.not_found', { ctx: req.ov }));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        if (err && err.type === 'entity.parse.failed') return http.sendProblem(res, 400, 'request.malformed_json', { ctx: req.ov });
        if (err && err.type === 'entity.too.large') return http.sendProblem(res, 413, 'request.too_large', { ctx: req.ov });
        if (err instanceof ServiceError && !res.headersSent) return http.sendProblem(res, err.status, err.code, { detail: err.detail, ctx: req.ov, extra: err.extra });
        log.error('[Services] unhandled error:', err);
        if (res.headersSent) return undefined;
        return http.sendProblem(res, 500, 'services.internal', { ctx: req.ov });
    });

    Object.assign(app.locals, { config, db, keys, userAuth, membership, authorities, tokens, index, outbox, apiAuth, metrics, registry });
    return app;
}

module.exports = { createApp, VERSION, JSON_LIMIT };
