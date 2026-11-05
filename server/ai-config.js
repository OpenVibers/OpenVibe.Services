'use strict';
/**
 * The `services.ai` configuration namespace (D11, owner settings): the three AI Exchange switches the owner
 * changes from openvibe.network's AI tab. The env variables stay the pins (`x-env`): while one is set it wins,
 * is read-only in the summary and a write answers 409 config.pinned_in_env. Nothing changes until the owner
 * sets a value in the store.
 *
 * `/internal/config` is openvibe-shared/config's adminRoutes, guarded by services.config.manage (Network's
 * service token, the only holder). actor is the owner Network names in X-OV-Subject; a secret or an x-danger
 * write needs X-OV-Fresh: 1. Every activation writes one audit line with the actor and the keys, never a value.
 */
const express = require('express');
const shared = require('openvibe-shared/config');
const { serviceAuth, capabilities, http, ids } = require('openvibe-contracts');

const SERVICE = 'services';
const NAMESPACE = 'services.ai';
const CAPABILITY = 'services.config.manage';
const GROUPS = 'AI Exchange';

const SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'OpenVibe.AI in the developer portal',
    description: 'The AI Exchange surfaces OpenVibe.Services offers: the model explorer and docs, the AI playground, and where the model catalog is read from.',
    type: 'object',
    additionalProperties: false,
    required: ['model_explorer', 'ai_playground', 'model_catalog_source'],
    properties: {
        model_explorer: {
            type: 'boolean', title: 'Model explorer and AI docs', 'x-group': GROUPS, 'x-env': 'SERVICES_MODEL_EXPLORER',
            description: 'Serve /models, /models/:id, /models/compare and /docs/ai. Off until the owner approves the public catalog and its prices.',
        },
        ai_playground: {
            type: 'boolean', title: 'AI playground', 'x-group': GROUPS, 'x-env': 'SERVICES_AI_PLAYGROUND',
            description: 'Offer the AI playground in a sandbox app: one non-streamed call as the app, never stored.',
        },
        model_catalog_source: {
            type: 'string', enum: ['preview', 'ai'], default: 'preview', title: 'Model catalog source', 'x-group': GROUPS, 'x-env': 'SERVICES_MODEL_CATALOG_SOURCE',
            description: 'preview reads the checked-in example catalog; ai reads OpenVibe.AI\'s live catalog and says when it cannot.',
        },
    },
};
const DEFAULTS = Object.freeze({ model_explorer: false, ai_playground: false, model_catalog_source: 'preview' });

function bearer(req) {
    const h = String((req.headers && req.headers.authorization) || '');
    return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

/** serviceAuth verify with the service's own key store; the capability is contracts' decision. */
function capabilityGuard({ keys, config, log }) {
    return async function guard(req, res, next) {
        try {
            const token = bearer(req);
            if (!token) return http.sendProblem(res, 401, 'token.missing', { detail: 'a Network service token is required', ctx: req.ov });
            const publicKey = typeof keys.pemForToken === 'function' ? await keys.pemForToken(token) : keys.get();
            if (!publicKey) return http.sendProblem(res, 503, 'identity.unavailable', { detail: 'the Network signing key is not loaded yet', ctx: req.ov });
            const r = serviceAuth.verifyServiceToken(token, { publicKey, issuer: config.network.issuer, audience: config.audience });
            if (!r.ok) return http.sendProblem(res, 401, r.code || 'token.invalid', { detail: r.reason || 'the token does not verify', ctx: req.ov });
            const sub = String((r.claims && r.claims.sub) || '');
            if (!sub.startsWith('svc:')) return http.sendProblem(res, 403, 'capability.denied', { detail: `${CAPABILITY} is first-party; an app may not change Services configuration`, ctx: req.ov });
            const decision = capabilities.check(r.claims, CAPABILITY);
            if (!decision.allowed) return http.sendProblem(res, 403, decision.code || 'capability.denied', { detail: decision.reason || `${CAPABILITY} not granted`, ctx: req.ov });
            req.configClaims = r.claims;
            return next();
        } catch (err) {
            log.error(`[config] services.ai guard failed: ${(err && err.message) || err}`);
            return http.sendProblem(res, 500, 'internal.error', { detail: 'the configuration request failed', ctx: req.ov });
        }
    };
}

function actor(req) {
    const named = String((req.headers && req.headers['x-ov-subject']) || '').trim();
    return ids.isSubjectId('user', named) ? { type: 'user', id: named } : null;
}

function requireFresh(req) {
    return String((req.headers && req.headers['x-ov-fresh']) || '') === '1';
}

async function create({ db, keys, config, env = process.env, log = console }) {
    const store = await shared.createConfigStore({
        db, service: SERVICE, namespace: NAMESPACE, schema: SCHEMA, defaults: DEFAULTS, env, log,
        onChange: ({ namespace, keys: changed, actor: who, revision }) => {
            const by = who && who.id ? `${who.type}:${who.id}` : 'unknown';
            log.info(`[config] ${SERVICE} ${namespace} revision ${revision} by ${by}: ${changed.join(', ')}`);
        },
    });
    if (env.OV_CONFIG_KEKS) {
        try { await store.reseal(); } catch (err) { log.warn(`[config] ${NAMESPACE}: reseal failed: ${(err && err.message) || err}`); }
    }
    const router = shared.adminRoutes([store], {
        basePath: '/internal/config', requireAdmin: capabilityGuard({ keys, config, log }), actor, requireFresh, log,
    });
    return {
        store, router,
        get: (key) => store.get(key),
        mount(app) {
            // The admin routes read the body themselves (adminRoutes' readBody), so no body parser is mounted here.
            app.use('/internal/config', express.json({ limit: '128kb' }));
            router.mount(app);
        },
    };
}

module.exports = { create, SCHEMA, NAMESPACE, CAPABILITY };
