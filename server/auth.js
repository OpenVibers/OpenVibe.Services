'use strict';

/**
 * Who is calling /api/v1 — resolved into req.principal:
 *
 *   { kind: 'service', sub: 'svc:live', cap: [...], claims, project_id, jti }  a Network client-credentials
 *                                              token for audience openvibe.services; the index routes
 *                                              check services.resource.read (server/api/v1.js).
 *   { kind: 'user', subject: 'usr_…', username, token }   a person's Network user token (SSO). A person
 *                                              reads ONLY projects they own or belong to, verified with
 *                                              their own token against Network (server/network.js
 *                                              projectMember), and only one project at a time.
 *   { kind: 'anonymous' }
 *
 * A request that presents a token is judged on that token alone: a bad one is refused, never downgraded.
 *
 * Capabilities: Services' capability ids are not registered in openvibe-contracts yet (plan T13 step 4
 * registers them after this repository exists). They live here in PROPOSED, and PROPOSED ids are decided
 * with contracts' own grant rules (wildcards included) so that what step 4 registers is exactly what
 * Services enforces. Once an id is registered, the contracts manifest decides, unchanged.
 */
const { serviceAuth, capabilities, http, ids } = require('openvibe-contracts');
const { ServiceError } = require('./util');

const PRINCIPAL_SUB = /^(svc|app|mod|agent):/;
const PROJECT_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const ANON = Object.freeze({ kind: 'anonymous' });

/**
 * The capabilities Services enforces (PROPOSED: no manifest in the pinned openvibe-contracts yet).
 * services.resource.read is the whole read side of the resource index (list, one, the authority list).
 * services.resource.control arrives with plan T13 step 10.
 */
const CAPS = Object.freeze({ resourceRead: 'services.resource.read' });
const PROPOSED = Object.freeze(new Set(Object.values(CAPS)));

/** One capability against a token's claims: contracts' manifest where there is one, the PROPOSED grant rules where not. */
function capabilityDecision(claims, id) {
    if (!PROPOSED.has(id)) return capabilities.check(claims, id);
    const allowed = capabilities.grants(claims && claims.cap, id);
    return allowed
        ? { allowed: true, code: null, reason: null }
        : { allowed: false, code: 'capability.denied', reason: `${id} not granted` };
}

function decodePayload(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
}

/** Verify a service token (audience openvibe.services). Returns { ok, claims } or { ok:false, code, reason }. */
function verifyService(token, { publicKey, issuer, audience }) {
    if (!publicKey) return { ok: false, code: 'identity.unavailable', reason: 'the Network signing key is not loaded yet' };
    const payload = decodePayload(token);
    if (!payload || typeof payload.sub !== 'string' || !PRINCIPAL_SUB.test(payload.sub)) return { ok: false, code: 'token.invalid', reason: 'not a service token' };
    const r = serviceAuth.verifyServiceToken(token, { publicKey, issuer, audience });
    if (!r.ok) return { ok: false, code: r.code, reason: r.reason };
    return { ok: true, claims: r.claims };
}

/** A Network user token's claims → the user principal (null when it names no canonical subject). */
function userPrincipal(claims, token) {
    if (!claims) return null;
    const subject = ids.isSubjectId('user', claims.subject_id) ? claims.subject_id : null;
    if (!subject) return null;
    return {
        kind: 'user', subject, token, username: claims.username || null,
        name: claims.display_name || claims.username || null, role: claims.role || 'user', cap: [], claims,
    };
}

/** The project a principal names, or null. */
const projectOf = (principal) => {
    const id = principal && principal.claims && principal.claims.project_id;
    return typeof id === 'string' && PROJECT_RE.test(id) ? id : null;
};

function createApiAuth({ config, keys, userAuth, membership }) {
    async function resolve(req) {
        const header = String(req.headers.authorization || '');
        if (!header.startsWith('Bearer ')) return { principal: ANON };
        const token = header.slice(7).trim();
        const publicKey = keys.get();
        if (!publicKey) return { error: [503, 'identity.unavailable', 'the Network signing key is not loaded yet'] };
        const payload = decodePayload(token);
        if (payload && typeof payload.sub === 'string' && PRINCIPAL_SUB.test(payload.sub)) {
            const r = verifyService(token, { publicKey, issuer: config.network.issuer, audience: config.audience });
            if (!r.ok) return { error: [401, r.code, r.reason] };
            return { principal: { kind: 'service', sub: r.claims.sub, cap: r.claims.cap || [], claims: r.claims, project_id: projectOf({ claims: r.claims }), jti: r.claims.jti } };
        }
        const claims = await userAuth.verify(token);
        if (!claims) return { error: [401, 'token.invalid', 'the user token is invalid or expired'] };
        const p = userPrincipal(claims, token);
        if (!p) return { error: [403, 'identity.no_subject', 'this account has no canonical subject yet; sign in again'] };
        return { principal: p };
    }

    async function middleware(req, res, next) {
        const r = await resolve(req);
        if (r.error) return http.sendProblem(res, r.error[0], r.error[1], { detail: r.error[2], ctx: req.ov });
        req.principal = r.principal;
        return next();
    }

    /**
     * The principal gate every index route runs first: anonymous 401, a service token without
     * services.resource.read 403. A user token passes here — what a person may see is the project
     * scope's question (authorizeProject), never this one's.
     */
    function requireRead(req) {
        const p = req.principal;
        if (!p || p.kind === 'anonymous') throw new ServiceError(401, 'token.missing', `${CAPS.resourceRead} needs a Network service or user token`);
        if (p.kind === 'service') {
            const d = capabilityDecision(p.claims, CAPS.resourceRead);
            if (!d.allowed) throw new ServiceError(403, d.code || 'capability.denied', d.reason || `${CAPS.resourceRead} not granted`);
            // First-party only (plan T13 step 4 registers services.resource.read first-party): an app,
            // mod or agent token is refused even if it somehow holds the grant. A person reads with their
            // own user token, never through a developer app's credential.
            if (!String(p.sub || '').startsWith('svc:')) {
                throw new ServiceError(403, 'capability.denied', `${CAPS.resourceRead} is first-party: a svc: service token or a person's own user token, never an app, mod or agent token`);
            }
        }
    }

    /** The first-party gate: a service token with services.resource.read (the authority registry). */
    function requireServiceRead(req) {
        requireRead(req);
        if (req.principal.kind !== 'service') throw new ServiceError(403, 'capability.denied', `${CAPS.resourceRead} is first-party: this route needs a service token`);
    }

    /**
     * The project a read is scoped to (null = every project a first-party caller may see):
     *
     *   service   any project; ?project= only narrows what a first-party caller sees
     *   user      only a project they own or belong to, named explicitly — Network answers it with the
     *             caller's own token, and a project they are not a member of is 404 (existence is not
     *             disclosed), never a 403 that would confirm it exists
     *
     * No person is ever accepted unscoped: a user token reads one project at a time.
     */
    async function authorizeProject(req, project) {
        const p = req.principal;
        if (p.kind === 'service') return { project };
        if (!project) throw new ServiceError(400, 'resources.project_required', 'a user token reads one project at a time: pass ?project=prj_…');
        if (!PROJECT_RE.test(String(project))) throw new ServiceError(400, 'resources.bad_query', 'project must be a prj_ id');
        const member = await membership.projectMember(p.token, project);
        if (member === 'unavailable') throw new ServiceError(503, 'network.unavailable', 'OpenVibe.Network could not answer whether this account may read that project');
        if (member !== 'yes') throw new ServiceError(404, 'resources.project_not_found', `no project ${project} for this account`);
        return { project };
    }

    return { middleware, resolve, capabilityDecision, requireRead, requireServiceRead, authorizeProject, projectOf };
}

module.exports = { createApiAuth, capabilityDecision, userPrincipal, verifyService, decodePayload, projectOf, CAPS, PROPOSED, PROJECT_RE, PRINCIPAL_SUB };
