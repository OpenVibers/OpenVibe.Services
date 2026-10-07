'use strict';

/**
 * The Services resource index (ADR-048, plan T13 step 6):
 *
 *   GET /api/v1/resources?project=&kind=&service=&cursor=&limit=   every authority's page, merged
 *   GET /api/v1/resources/:ovrn                                    one resource, asked of its authority
 *
 * The fan-out, each authority's opaque-cursor walk and the merge are openvibe-sdk/resources'
 * `createResourceIndex` — Services does not reimplement any of it. Services adds:
 *
 *   - the authority set (one adapter each, its own client-credentials token; server/authorities/),
 *   - a deterministic total order over the merged resources (service, ovrn, id) and an opaque keyset
 *     cursor into it, so a page walk never repeats or skips a resource,
 *   - a local filter for `project` / `kind` / `service` on top of the authorities' own answers: a
 *     scoped read (a person's, above all) must never show a row outside its scope even if an authority
 *     ignores a query parameter,
 *   - and the partial answer. common.resource-list-result@1's `partial` array (contracts 1.1.0) names
 *     the authorities this merge could not read and the problem code each answered — their rows are
 *     omitted, the rest of the page is served (ADR-046 section 6: an authority, or Network, being
 *     down degrades the index; it never stops it). A complete page carries no `partial` key at all.
 *
 * One resource is never merged: /api/v1/resources/:ovrn parses the name with the one parser
 * (contracts.resources.parse), resolves the owning service and asks that authority directly.
 */
const contracts = require('openvibe-contracts');
const { createResourceIndex } = require('openvibe-sdk/resources');
const { createAuthorityAdapter, createAuthorityFetcher } = require('./authorities/adapter');
const { ServiceError, parseOvrn } = require('./util');

const CURSOR_V = 'v1';
const SEP = '\u0000';

/**
 * The problem code a partial page names for one authority. The authority's own problem code when it
 * answered one; Services' own resources.* codes when nothing answered — resources.authority_timeout when the request or
 * the cursor walk timed out, resources.authority_unavailable when the network (or Network's token mint)
 * failed. The codes live here, in the body only; nothing new is registered in contracts.
 */
const PARTIAL_CODES = Object.freeze({ 'sdk.timeout': 'resources.authority_timeout', 'sdk.network_error': 'resources.authority_unavailable' });
const partialCodeOf = (stale) => PARTIAL_CODES[stale.code] || stale.code || 'resources.authority_unavailable';

/** The order a page is cut in: service, then the OVRN when the summary has one (else its id). */
const sortKeyOf = (r) => `${r.service}${SEP}${r.ovrn || ''}${SEP}${r.id}`;
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const encodeCursor = (key) => Buffer.from(JSON.stringify([CURSOR_V, key])).toString('base64url');
function decodeCursor(raw) {
    let v;
    try { v = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8')); } catch { return null; }
    return Array.isArray(v) && v.length === 2 && v[0] === CURSOR_V && typeof v[1] === 'string' ? v[1] : null;
}

function createResourceIndexService({ config, authorities, tokens, fetchImpl = globalThis.fetch, log = console }) {
    const adapters = authorities.list().map((a) => createAuthorityAdapter(a, { tokens, fetchImpl, timeoutMs: config.index.timeoutMs }));
    const adapterById = new Map(adapters.map((a) => [a.authority.id, a]));
    const idByOrigin = new Map(adapters.map((a) => [a.origin, a.authority.id]));
    const indexes = new Map();
    let lastPartial = '';

    /** One SDK index per authority set (all of them, or the one ?service= names), created once. */
    function indexFor(set) {
        const key = set.map((a) => a.authority.id).join(',');
        let index = indexes.get(key);
        if (!index) {
            index = createResourceIndex({
                authorities: set.map((a) => a.origin),
                fetch: createAuthorityFetcher(set),
                pageLimit: config.index.pageSize,
                concurrency: config.index.concurrency,
                timeoutMs: config.index.timeoutMs,
            });
            indexes.set(key, index);
        }
        return index;
    }

    /**
     * One merged page. `{ resources, next_cursor, partial }` — `partial` lists `{ service, code }` for the
     * authorities whose rows this page could not include (their cursor walk failed, timed out or was
     * refused), `code` being the problem code each one answered, in the caller's terms.
     */
    async function list({ project = null, kind = null, service = null, cursor = null, limit = config.index.defaultLimit } = {}) {
        const set = service ? adapters.filter((a) => a.authority.id === service) : adapters;
        if (service && !set.length) throw new ServiceError(400, 'resources.unknown_service', `${service} is not an authority Services reads`);
        if (!set.length) return { resources: [], next_cursor: null, partial: [] };
        const { resources, stale } = await indexFor(set).list({ project, kind, limit: config.index.pageSize });
        let merged = resources;
        // The authority filters on its own; this keeps a scoped read scoped even if one does not
        // (project_id is optional on common.resource-summary@1, so a row without one fails a project filter).
        if (service) merged = merged.filter((r) => r.service === service);
        if (kind) merged = merged.filter((r) => r.kind === kind);
        if (project) merged = merged.filter((r) => r.project_id === project);
        merged = merged.slice().sort((a, b) => compare(sortKeyOf(a), sortKeyOf(b)));
        const after = cursor ? decodeCursor(cursor) : null;
        if (cursor && after === null) throw new ServiceError(400, 'resources.bad_query', 'cursor must be one this index issued');
        const rest = after ? merged.filter((r) => compare(sortKeyOf(r), after) > 0) : merged;
        const page = rest.slice(0, limit);
        const partial = stale.map((s) => ({ service: idByOrigin.get(s.authority) || s.authority, code: partialCodeOf(s) }));
        // One line when the set of silent authorities changes — an operator wants to know, a log wants no
        // flood; the caller reads the same fact from the response body's `partial`.
        const signature = partial.map((p) => `${p.service} (${p.code})`).join(', ');
        if (signature !== lastPartial) {
            if (signature) log.warn(`[Services] index partial: ${signature}`);
            lastPartial = signature;
        }
        return {
            resources: page,
            next_cursor: rest.length > limit ? encodeCursor(sortKeyOf(page[page.length - 1])) : null,
            partial,
        };
    }

    /**
     * The OVRN's four segments and the authority that owns it, or ServiceError: 400 resources.bad_name
     * (not an OVRN at all) / 400 resources.unknown_service (no authority of that id). A route authorizes
     * with the returned project BEFORE anything is asked of the authority.
     */
    function resolve(ovrn) {
        const parsed = parseOvrn(ovrn);                         // contracts.resources.parse, the one parser
        const adapter = adapterById.get(parsed.service);
        if (!adapter) throw new ServiceError(400, 'resources.unknown_service', `${parsed.service} is not an authority Services reads`);
        return { ...parsed, adapter };
    }

    /** The summary whose OVRN this is, from the authority that owns it. Throws ServiceError on refusal. */
    async function get(ovrn) {
        const parsed = resolve(ovrn);
        const { status, body } = await parsed.adapter.get(ovrn);
        if (status === 404) throw new ServiceError(404, 'resources.not_found', `no resource named ${ovrn}`);
        if (status !== 200) throw new ServiceError(502, 'resources.authority_error', `${parsed.service} answered HTTP ${status} for ${ovrn}`);
        const check = contracts.validate('common.resource-summary@1', body);
        if (!check.valid) throw new ServiceError(502, 'resources.authority_bad_response', `${parsed.service} answered something that is not a common.resource-summary@1`);
        if (body.ovrn !== ovrn && contracts.resources.nameOf(body) !== ovrn) {
            throw new ServiceError(502, 'resources.authority_bad_response', `${parsed.service} answered a resource that is not ${ovrn}`);
        }
        return body;
    }

    /** Drop the cached SDK indexes (an authority set changed at runtime — boot-time registry today). */
    function reset() { indexes.clear(); }

    return { list, get, resolve, reset, adapters };
}

module.exports = { createResourceIndexService, encodeCursor, decodeCursor, sortKeyOf };
