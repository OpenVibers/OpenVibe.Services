'use strict';
/**
 * OpenAPI 3.1 for OpenVibe.Services' JSON API, from the route table below.
 *
 * ROUTES is the table: every entry is one method on one path under /api/v1. server/app.js mounts the
 * resource-index router (server/api/v1.js) and the release/docs router (server/http/api.js), and
 * test/openapi.test.js walks the mounted stack and fails when the table and the app differ in either
 * direction — so the document cannot advertise an address this service does not answer.
 *
 *   GET /openapi.json            this document (public, Cache-Control 5 minutes)
 *   GET /api/v1/openapi.json     308 to /openapi.json
 *
 * /api/health and /api/ready are probes; the developer console (/projects), the docs pages (/docs),
 * the release action pages (/releases/:id/*) and SSO (/auth/*) are pages, not this API.
 *
 * Request fields are what server/api/v1.js and server/http/api.js read; response properties are the
 * shapes those handlers and server/domain/*.js serialize. Nothing is inferred.
 */
const pkg = require('../../package.json');

const MOUNT = '/api/v1';
const SITE = 'https://openvibe.services';

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const str = (extra = {}) => ({ type: 'string', ...extra });
const nullable = (type, extra = {}) => ({ type: [type, 'null'], ...extra });
const arrayOf = (items) => ({ type: 'array', items });
const integer = (extra = {}) => ({ type: 'integer', ...extra });

const problem = {
    description: 'A problem (RFC 9457, application/problem+json): type, title, status and a stable code',
    content: {
        'application/problem+json': {
            schema: {
                type: 'object',
                required: ['type', 'title', 'status'],
                properties: { type: str(), title: str(), status: integer(), code: str(), detail: str(), request_id: str() },
            },
        },
    },
};
const errors = (codes = [400, 401, 403, 404, 409, 413, 422, 429]) => ({
    ...Object.fromEntries(codes.map((code) => [code, problem])),
    default: problem,
});

const path = (name, schema, description) => ({ name, in: 'path', required: true, schema, ...(description && { description }) });
const query = (name, schema, description) => ({ name, in: 'query', required: false, schema, ...(description && { description }) });

const ANONYMOUS = [{}, { bearer: [] }];
const SERVICE = [{ bearer: [] }];
const APP = [{ bearer: [] }];

const json = (description, schema) => ({ description, ...(schema ? { content: { 'application/json': { schema } } } : {}) });
const body = (schema, required = true) => ({ required, content: { 'application/json': { schema } } });

const appId = str({ pattern: '^app_[0-9A-HJKMNP-TV-Z]{26}$' });
const releaseId = str({ pattern: '^rel_[0-9A-HJKMNP-TV-Z]{26}$' });

const PATHS = {};
function route(method, p, operation) {
    (PATHS[p] = PATHS[p] || {})[method] = operation;
}

// ── Resource index ───────────────────────────────────────────────────────────────────────────
route('get', '/resources', {
    operationId: 'listResources', summary: 'One merged page of resources over every authority', tags: ['resources'], security: SERVICE,
    description: 'services.resource.read: a Network service token (any project; ?project= only narrows) or a person\'s user token scoped to one project they own or belong to. A failing authority\'s rows are omitted and named in `partial`.',
    parameters: [
        query('project', str({ pattern: '^prj_[0-9A-HJKMNP-TV-Z]{26}$' }), 'The tenancy boundary'), query('kind', str({ pattern: '^[a-z][a-z0-9-]{0,31}\\.[a-z][a-z0-9-]{0,39}$' })),
        query('service', str({ pattern: '^[a-z][a-z0-9-]{0,31}$' })), query('cursor', str({ maxLength: 2048 })), query('limit', integer({ minimum: 1 })),
    ],
    responses: { 200: json('common.resource-list-result@1', { type: 'object', required: ['resources', 'next_cursor'], properties: {
        resources: arrayOf(ref('ResourceSummary')), next_cursor: nullable('string'),
        partial: arrayOf({ type: 'object', properties: { service: str(), code: str() } }),
    } }), ...errors([400, 401, 403, 404, 429, 502, 503]) },
});
route('post', '/resources/control', {
    operationId: 'controlResource', summary: 'One control operation, routed to the authority that owns the resource', tags: ['resources'], security: SERVICE,
    description: 'services.resource.control: a service token (any project) or a person\'s user token for a project they own or administer. Body common.resource-control-request@1; the answer is the owning authority\'s common.resource-control-result@1 (200, or 202 while pending). An authority refusal is a result with state refused or failed, never an HTTP error.',
    requestBody: body(ref('ResourceControlRequest')),
    responses: { 200: json('common.resource-control-result@1', ref('ResourceControlResult')),
        202: json('Pending at the authority', ref('ResourceControlResult')), ...errors([400, 401, 403, 404, 409, 429, 502, 503]) },
});
route('get', '/resources/{ovrn}', {
    operationId: 'getResource', summary: 'One resource by its OVRN, from the authority that owns it', tags: ['resources'], security: SERVICE,
    description: 'services.resource.read. A malformed OVRN is 400; a person must be a member of the project it names.',
    parameters: [path('ovrn', str())],
    responses: { 200: json('common.resource-summary@1', ref('ResourceSummary')), ...errors([400, 401, 403, 404, 429, 502, 503]) },
});
route('get', '/authorities', {
    operationId: 'listAuthorities', summary: 'The authorities this index reads and where they listen', tags: ['resources'], security: SERVICE,
    description: 'services.resource.read, service principals only. First-party operational data (loopback origins); Services-local, no contract yet.',
    responses: { 200: json('Authorities', { type: 'object', required: ['authorities'], properties: { authorities: arrayOf(ref('Authority')) } }), ...errors([401, 403, 429]) },
});

// ── Docs versions and manifest validation ───────────────────────────────────────────────────
route('get', '/docs/versions', {
    operationId: 'docsVersions', summary: 'The pinned versions the docs were generated from', tags: ['docs'], security: [{}],
    responses: { 200: json('Versions and counts', { type: 'object', properties: {
        contracts: str(), contracts_tag: str(), sdk: str(), sdk_tag: str(), generated_at: str({ format: 'date-time' }),
        contracts_count: integer(), capabilities_count: integer(),
    } }), ...errors([429]) },
});
route('post', '/manifests/validate', {
    operationId: 'validateManifest', summary: 'Validate an app or mod manifest', tags: ['docs'], security: [{}],
    description: 'Rate limited. kind is app or mod; 200 when valid, 422 when not.',
    requestBody: body({ type: 'object', required: ['kind', 'manifest'], properties: {
        kind: { type: 'string', enum: ['app', 'mod'] }, manifest: { type: 'object' },
    } }),
    responses: { 200: json('Valid, with warnings', ref('ManifestValidation')), 422: { ...problem, description: 'Not valid' }, ...errors([429]) },
});

// ── Releases ────────────────────────────────────────────────────────────────────────────────
route('get', '/apps/{app}/releases', {
    operationId: 'listAppReleases', summary: 'An app\'s public releases and trust tier', tags: ['releases'], security: ANONYMOUS,
    description: 'services.release.read. Anonymous callers pass; a presented token must be valid and hold services.release.read. Drafts never appear.',
    parameters: [path('app', appId)],
    responses: { 200: json('The app, its trust tier and public releases', { type: 'object', required: ['app_id', 'trust', 'releases'], properties: {
        app_id: str(), trust: ref('Trust'), releases: arrayOf(ref('Release')),
    } }), ...errors([401, 403, 404, 429]) },
});
route('get', '/apps/{app}/trust', {
    operationId: 'getAppTrust', summary: 'An app\'s trust tier (metadata only)', tags: ['releases'], security: ANONYMOUS,
    description: 'services.release.read. Grants in OpenVibe.Network are the authority.',
    parameters: [path('app', appId)],
    responses: { 200: json('The app and its trust tier', { allOf: [ref('Trust'), { type: 'object', properties: { app_id: str(), note_on_authority: str() } }] }), ...errors([401, 403, 404, 429]) },
});
route('get', '/releases/{id}', {
    operationId: 'getRelease', summary: 'One public release with its manifest', tags: ['releases'], security: ANONYMOUS,
    description: 'services.release.read. A draft answers 404.',
    parameters: [path('id', releaseId)],
    responses: { 200: json('The release and its manifest', { type: 'object', required: ['release'], properties: {
        release: ref('Release'), manifest: nullable('object'),
    } }), ...errors([401, 403, 404, 429]) },
});
route('post', '/apps/{app}/releases', {
    operationId: 'createRelease', summary: 'An app creates its own release (draft, or published)', tags: ['releases'], security: APP,
    description: 'services.release.manage: only an app token, and only for its own app. `publish: true` publishes it in the same call.',
    parameters: [path('app', appId)],
    requestBody: body({ type: 'object', required: ['manifest'], properties: {
        kind: { type: 'string', enum: ['app', 'mod'] }, manifest: { type: 'object' }, notes: str(), publish: { type: 'boolean' },
    } }),
    responses: { 201: json('The release and validation warnings', { type: 'object', required: ['release'], properties: {
        release: ref('Release'), warnings: arrayOf(str()),
    } }), ...errors([400, 401, 403, 404, 409, 422, 429]) },
});
for (const action of ['publish', 'deprecate', 'revoke']) {
    route('post', `/releases/{id}/${action}`, {
        operationId: `${action}Release`, summary: `${action[0].toUpperCase()}${action.slice(1)} a release (its app only)`, tags: ['releases'], security: APP,
        description: 'services.release.manage. deprecate needs a reason; revoke needs a reason and is final.',
        parameters: [path('id', releaseId)],
        requestBody: body({ type: 'object', properties: {
            reason: str({ maxLength: 500 }), replacement: releaseId, notes: str(),
        } }, action !== 'publish'),
        responses: { 200: json('The release and the event it announced', { type: 'object', required: ['release'], properties: {
            release: ref('Release'), event_id: nullable('string'),
        } }), ...errors([400, 401, 403, 404, 409, 422, 429]) },
    });
}

function openapi() {
    return {
        openapi: '3.1.0',
        info: {
            title: 'OpenVibe.Services API',
            version: pkg.version,
            description: pkg.description,
            license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
            contact: { name: 'OpenVibers', url: 'https://github.com/OpenVibers/OpenVibe.Services', email: 'contact@openvibe.network' },
        },
        servers: [{ url: SITE }],
        tags: ['resources', 'docs', 'releases'].map((name) => ({ name })),
        components: {
            securitySchemes: {
                bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'A Network service token for audience openvibe.services carrying the route\'s capability (services.resource.read, services.resource.control, services.release.read), or a person\'s user token scoped to one project' },
                app: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'An app token for audience openvibe.services carrying services.release.manage; it manages only its own releases' },
            },
            schemas: {
                ResourceSummary: { type: 'object', required: ['id', 'kind', 'service', 'state'], properties: {
                    id: str(), kind: str(), service: str(), project_id: str({ pattern: '^prj_' }),
                    owner: { type: 'object', properties: { type: str(), id: str() } }, name: nullable('string'), state: str(),
                    created_at: str({ format: 'date-time' }), ovrn: str(),
                } },
                ResourceControlRequest: { type: 'object', required: ['action', 'idempotency_key'], properties: {
                    resource: str({ description: 'The resource OVRN' }), resource_kind: str(), project_id: str({ pattern: '^prj_' }),
                    on_behalf_of: { type: 'object', properties: { type: str(), id: str() } }, action: str(),
                    dry_run: { type: 'boolean' }, idempotency_key: str(),
                } },
                ResourceControlResult: { type: 'object', required: ['action', 'state', 'at'], properties: {
                    action: str(), resource: str(), state: { type: 'string', enum: ['done', 'refused', 'failed', 'pending'] },
                    at: str({ format: 'date-time' }), result: nullable('object'), problem: nullable('object'),
                } },
                Authority: { type: 'object', properties: {
                    id: str(), name: str(), origin: str(), public_origin: str(), audience: str(), capability: str(),
                    manifest_version: str(), contracts_range: str(), status: str(),
                } },
                ManifestValidation: { type: 'object', required: ['valid'], properties: {
                    valid: { type: 'boolean' }, errors: arrayOf({ type: 'object' }), warnings: arrayOf({ type: 'object' }), contracts_version: str(),
                } },
                Trust: { type: 'object', properties: {
                    tier: str(), note: nullable('string'), set_by: nullable('string'), set_at: nullable('string', { format: 'date-time' }),
                } },
                Release: { type: 'object', required: ['id', 'app_id', 'status'], properties: {
                    id: releaseId, app_id: appId, project_id: str(), environment: { type: 'string', enum: ['production', 'sandbox'] },
                    kind: { type: 'string', enum: ['app', 'mod'] }, subject_id: str(), name: str(), version: str(),
                    status: { type: 'string', enum: ['draft', 'published', 'deprecated', 'revoked'] }, manifest_id: str(),
                    compatibility: { type: 'object' }, notes: nullable('string'), created_at: str({ format: 'date-time' }), created_by: str(),
                    published_at: nullable('string', { format: 'date-time' }), deprecated_at: nullable('string', { format: 'date-time' }),
                    deprecation_reason: nullable('string'), replacement: nullable('string'), revoked_at: nullable('string', { format: 'date-time' }),
                    revocation_reason: nullable('string'), trust: ref('Trust'),
                } },
            },
        },
        paths: { ...Object.fromEntries(Object.entries(PATHS).sort(([a], [b]) => a.localeCompare(b)).map(([p, item]) => [MOUNT + p, item])) },
    };
}

/** The documented routes as "METHOD /api/v1/path": what the app must mount. */
function routes() {
    return Object.entries(PATHS).flatMap(([p, item]) => Object.keys(item).map((method) => `${method.toUpperCase()} ${MOUNT}${p}`)).sort();
}

/** Serve GET /openapi.json here; GET /api/v1/openapi.json redirects to it (308). */
function mount(app, document = openapi()) {
    const send = (_req, res) => {
        res.set('Cache-Control', 'public, max-age=300');
        res.type('application/json; charset=utf-8').send(JSON.stringify(document));
    };
    app.get('/openapi.json', send);
    app.get('/api/v1/openapi.json', (_req, res) => res.redirect(308, '/openapi.json'));
}

module.exports = { openapi, routes, mount, MOUNT };
