'use strict';

/**
 * /api/v1 — the Services resource index (ADR-048, plan T13 step 6). The route → capability map:
 *
 * | Method & path              | Capability                 | Request → answer                                          |
 * |----------------------------|----------------------------|-----------------------------------------------------------|
 * | GET /api/v1/resources      | services.resource.read     | ?project=&kind=&service=&cursor=&limit= → common.resource-list-result@1 (merged over every authority; the authorities a page could not read are named in X-OpenVibe-Partial-Authorities) |
 * | GET /api/v1/resources/:ovrn| services.resource.read     | common.no-body@1 → common.resource-summary@1 from the authority that owns it |
 * | GET /api/v1/authorities    | services.resource.read     | common.no-body@1 → { authorities: […] } (Services-local; no contract yet) |
 *
 * services.resource.read is PROPOSED (server/auth.js): it is not in the pinned openvibe-contracts yet
 * (plan T13 step 4 registers it), and Services enforces exactly the id it will register.
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
const { http } = require('openvibe-contracts');
const { ServiceError } = require('../util');

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

function v1Router({ config, apiAuth, index, authorities }) {
    const r = express.Router();

    // One merged page over every authority (or the one ?service= names). A failing authority's rows are
    // omitted and named in the partial header; the rest of the page is served.
    r.get('/resources', async (req, res) => {
        apiAuth.requireRead(req);
        const filter = listQuery(req.query, config);
        const scope = await apiAuth.authorizeProject(req, filter.project);
        const page = await index.list({ ...filter, project: scope.project });
        if (page.partial.length) res.set('X-OpenVibe-Partial-Authorities', page.partial.join(', '));
        res.json({ resources: page.resources, next_cursor: page.next_cursor });
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
