'use strict';

/**
 * /api/v1 — the Services resource index (ADR-048, plan T13 step 6). The route → capability map:
 *
 * | Method & path              | Capability                 | Request → answer                                          |
 * |----------------------------|----------------------------|-----------------------------------------------------------|
 * | GET /api/v1/resources      | services.resource.read     | ?project=&kind=&service=&cursor=&limit= → common.resource-list-result@1 (merged over every authority; a page that could not read one names it in `partial: [{ service, code }]`) |
 * | GET /api/v1/resources/:ovrn| services.resource.read     | common.no-body@1 → common.resource-summary@1 from the authority that owns it |
 * | GET /api/v1/authorities    | services.resource.read     | common.no-body@1 → { authorities: […] } (Services-local; no contract yet) |
 * | POST /api/v1/resources/control | services.resource.control | common.resource-control-request@1 → common.resource-control-result@1 from the owning authority (200; 202 when pending) |
 *
 * services.resource.read and services.resource.control are registered in the pinned openvibe-contracts (status
 * active, visibility first-party): contracts' manifest decides them, and an id contracts does not know is refused,
 * never allowed.
 *
 * Control (plan T13 step 10): a service token holding services.resource.control (any project), or a person's user
 * token for a project they own or administer (Network answers the role). The body is checked with
 * contracts.resources.checkControlRequest (400 control.bad_request); idempotency, the sensitive-action gate and the
 * control-log and audit rows are server/domain/control.js; the forwarding is server/resources.js. 409
 * control.idempotency_conflict / control.in_progress for a reused or running idempotency_key. An authority's refusal or
 * failure is a result with state refused or failed, never an HTTP error.
 *
 * Who may call: a Network service token holding services.resource.read (any project, ?project= only
 * narrows), or a person's user token — scoped to ONE project they own or belong to, verified with their
 * own token against Network (server/auth.js authorizeProject). Never an unscoped person.
 *
 * Errors are RFC 9457 problem+json: 400 resources.bad_query / resources.bad_name /
 * resources.unknown_service / resources.project_required, 401 token.missing, 403 capability.denied,
 * 404 resources.not_found, 502 resources.authority_unavailable / resources.authority_error, 503
 * network.unavailable.
 */
const express = require('express');
const { http, resources } = require('openvibe-contracts');
const { ServiceError } = require('../util');
const { httpStatusOf } = require('../domain/control');

const PROJECT_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const SERVICE_RE = /^[a-z][a-z0-9-]{0,31}$/;
const KIND_RE = /^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,39}$/;

/** The list query, or a 400. An absent filter is null; a malformed one is refused, never ignored. */
function listQuery(query, config) {
    const out = { project: null, kind: null, service: null, cursor: null, limit: config.index.defaultLimit };
    if (query.project != null && query.project !== '') {
        if (typeof query.project !== 'string' || !PROJECT_RE.test(query.project)) throw new ServiceError(400, 'resources.bad_query', 'project must be a prj_ id');
        out.project = query.project;
    }
    if (query.kind != null && query.kind !== '') {
        if (typeof query.kind !== 'string' || !KIND_RE.test(query.kind)) throw new ServiceError(400, 'resources.bad_query', 'kind must be <service>.<type>');
        out.kind = query.kind;
    }
    if (query.service != null && query.service !== '') {
        if (typeof query.service !== 'string' || !SERVICE_RE.test(query.service)) throw new ServiceError(400, 'resources.bad_query', 'service must be a service id');
        out.service = query.service;
    }
    if (query.cursor != null && query.cursor !== '') {
        // The shape is checked here; whether it is a cursor THIS index issued is the index's own check
        // (server/resources.js decodeCursor), so there is one cursor format and one place that knows it.
        if (typeof query.cursor !== 'string' || query.cursor.length > 2048) throw new ServiceError(400, 'resources.bad_query', 'cursor must be one this index issued');
        out.cursor = query.cursor;
    }
    if (query.limit != null && query.limit !== '') {
        if (typeof query.limit !== 'string' || !/^\d+$/.test(query.limit) || Number(query.limit) < 1 || Number(query.limit) > config.index.maxLimit) {
            throw new ServiceError(400, 'resources.bad_query', `limit must be an integer 1-${config.index.maxLimit}`);
        }
        out.limit = Number(query.limit);
    }
    return out;
}

function v1Router({ config, apiAuth, index, authorities, control }) {
    const r = express.Router();

    // One merged page over every authority (or the one ?service= names). A failing authority's rows are
    // omitted and named in the body's `partial` array (common.resource-list-result@1); the rest of the
    // page is served, and a complete page carries no `partial` key at all.
    r.get('/resources', async (req, res) => {
        apiAuth.requireRead(req);
        const filter = listQuery(req.query, config);
        const scope = await apiAuth.authorizeProject(req, filter.project);
        const page = await index.list({ ...filter, project: scope.project });
        res.json(page.partial.length
            ? { resources: page.resources, next_cursor: page.next_cursor, partial: page.partial }
            : { resources: page.resources, next_cursor: page.next_cursor });
    });

    // One control operation, routed to the authority that owns the resource. The body is validated, the caller authorized
    // for its project_id (which the contract ties to the resource's own project) and only then is anything claimed,
    // gated or forwarded.
    r.post('/resources/control', async (req, res) => {
        apiAuth.requireControl(req);
        const request = req.body;
        const check = request && typeof request === 'object' && !Array.isArray(request)
            ? resources.checkControlRequest(request)
            : { valid: false, errors: [{ path: '', message: 'the body is a JSON object' }] };
        if (!check.valid) {
            throw new ServiceError(400, 'control.bad_request', 'the body is not a valid common.resource-control-request@1',
                { errors: check.errors.slice(0, 20).map((e) => ({ path: String(e.path || e.instancePath || ''), message: String(e.message || 'invalid') })) });
        }
        await apiAuth.authorizeControl(req, request.project_id);
        const result = await control.run(request, req.principal);
        res.status(httpStatusOf(result)).json(result);
    });

    // One resource by its OVRN, straight from the authority that owns it. The OVRN is parsed first (400),
    // the owning service resolved (400), and the caller authorized for its project — a person must be a
    // member of that project; a service token needs services.resource.read. Nothing is asked of the
    // authority before the caller is authorized.
    r.get('/resources/:ovrn', async (req, res) => {
        apiAuth.requireRead(req);
        const ovrn = String(req.params.ovrn);
        const { project_id: project } = index.resolve(ovrn);
        await apiAuth.authorizeProject(req, project);
        res.json(await index.get(ovrn));
    });

    // The authorities Services reads, and where they listen. First-party operational data (loopback
    // origins), so a service token with services.resource.read — not the person-facing path. A
    // Services-local answer: no contract names it yet.
    r.get('/authorities', async (req, res) => {
        apiAuth.requireServiceRead(req);
        res.json({
            authorities: authorities.list().map((a) => ({
                id: a.id, name: a.name, origin: a.internalOrigin, public_origin: a.publicOrigin,
                audience: a.audience, capability: a.capability, manifest_version: a.manifestVersion,
                contracts_range: a.contractsRange, status: a.status,
            })),
        });
    });

    r.use((req, res) => http.sendProblem(res, 404, 'route.not_found', { ctx: req.ov }));
    return r;
}

module.exports = { v1Router, listQuery };
