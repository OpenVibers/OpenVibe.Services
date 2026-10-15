'use strict';

/**
 * Control operations (ADR-048, plan T13 step 10): POST /api/v1/resources/control, one common.resource-control-request@1
 * in, one common.resource-control-result@1 out. Services decides none of it: the owning authority applies or refuses
 * (server/resources.js `control`, through openvibe-sdk/resources' createResourceClient). What this module adds around that:
 *
 *   - Idempotency on idempotency_key: services_control_log has one row per key (UNIQUE). The first request claims it
 *     (status pending, no answer yet), a repeat with the same key gets the stored answer and the authority is not asked
 *     again, a repeat while the first is still running is 409 control.in_progress, and the key reused by another caller
 *     or for another request (action, resource, project, params, on_behalf_of, dry_run) is 409
 *     control.idempotency_conflict. A claim left unanswered for 5 minutes (a crash mid-call) may be taken over; the
 *     authority's own idempotency on the same key keeps that safe.
 *   - The sensitive-action gate (roadmap WS-Z2): a request an agent makes (on_behalf_of { type: 'agent' }) that deletes,
 *     spends money (a money field in params) or publishes (params.publish / public / visibility 'public') is refused
 *     with confirmation_required until the agent's owner approves it. Network's confirmations
 *     (server/clients/confirmations.js) mint the confirmation id, ask the owner and keep the decision; the retry carries
 *     confirmation_id (with the same key or a new one) and Services spends the approval once, for exactly this request
 *     (its digest), before the authority is asked. A standing rule's approval proceeds at once. A person acting with
 *     their own token, and a dry run, are not gated here; the authority's own gate still applies, and its
 *     confirmation_required answers pass through unchanged.
 *   - The record: the log row's answer, and one services_audit row for every request accepted here (a replay too),
 *     written together. Neither stores params (only their digest) or any token.
 */
const crypto = require('crypto');
const { controlResult } = require('../resources');
const { ServiceError } = require('../util');

const STALE_MS = 5 * 60_000;
const MONEY_KEY = /(^|_)(amount|price|budget|spend|cost|payment|charge|credits?|cents|currency|billing)(_|$)/;

/** Why a request is sensitive (deleting, money, publishing), or null. A dry run applies nothing, so it is never gated. */
function sensitiveReason(request) {
    if (request.dry_run === true) return null;
    if (request.action === 'delete') return 'deleting a resource';
    const params = request.params || {};
    if (Object.keys(params).some((k) => MONEY_KEY.test(k.toLowerCase()))) return 'spending money';
    if (params.publish === true || params.public === true || params.visibility === 'public') return 'publishing';
    return null;
}

/** JSON with sorted object keys, so equal requests digest equally whatever their key order. */
function canonical(v) {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    return JSON.stringify(v);
}
const digestOf = (v) => crypto.createHash('sha256').update(canonical(v)).digest('hex');

/** What the request asks for, without its delivery fields (idempotency_key, confirmation_id, trace_id). */
const ACTION_FIELDS = ['action', 'resource', 'resource_kind', 'owned', 'owner', 'project_id', 'params', 'on_behalf_of', 'dry_run'];
const actionOf = (request) => Object.fromEntries(ACTION_FIELDS.filter((k) => request[k] !== undefined).map((k) => [k, request[k]]));

const actorOf = (principal) => (principal.kind === 'user' ? `user:${principal.subject}` : principal.sub);

/** The HTTP status a result is sent with: 202 for pending (the authority finishes later), 200 for every other state. */
const httpStatusOf = (result) => (result.state === 'pending' ? 202 : 200);

function createControl({ store, index, confirmations, log = console }) {
    const db = store.db;

    async function audit({ actor, target, project, detail }) {
        await db.query('INSERT INTO services_audit (at, actor, action, target, project_id, detail) VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
            [store.iso(), actor, 'resource.control', target, project, JSON.stringify(detail)]);
    }

    /**
     * The sensitive-action gate, then the authority. `forward` is the request as the authority gets it (no
     * confirmation_id of Services' own); `digest` names exactly this action for Network's confirmation.
     */
    async function decide(forward, confirmationId, onBehalfOf, digest) {
        const reason = sensitiveReason(forward);
        if (!reason || !onBehalfOf || onBehalfOf.type !== 'agent') {
            return index.control(confirmationId ? { ...forward, confirmation_id: confirmationId } : forward);
        }
        // Network unreachable: nothing was decided, so failed; Network said no: refused with its problem.
        const notConfirmed = (r) => controlResult(forward, r.status === 503 ? 'failed' : 'refused', { problem: r });
        let id = confirmationId;
        if (!id) {
            const named = forward.resource || forward.resource_kind;
            const c = await confirmations.create({
                agentId: onBehalfOf.id,
                summary: `${forward.action} ${named}`.slice(0, 500),
                details: { action: forward.action, [forward.resource ? 'resource' : 'resource_kind']: named, project_id: forward.project_id, reason },
                requestDigest: digest,
            });
            if (!c.ok) return notConfirmed(c);
            if (c.confirmation.state !== 'approved') {
                return controlResult(forward, 'refused', { confirmationRequired: { confirmation_id: c.confirmation.id, reason: `${reason} needs its owner's approval` } });
            }
            id = c.confirmation.id;                         // a standing rule approved it at creation
        }
        const spent = await confirmations.consume(id, digest);
        // Not approved (yet): the answer keeps confirmation_required, so a later retry with the same key and id still counts.
        if (!spent.ok && spent.code === 'confirmation.not_pending') {
            return controlResult(forward, 'refused', { problem: spent, confirmationRequired: { confirmation_id: id, reason: `${reason} needs its owner's approval` } });
        }
        if (!spent.ok) return notConfirmed(spent);
        return index.control(forward);
    }

    /**
     * One control request from an authorized principal (server/api/v1.js has validated it and authorized its project)
     * → its common.resource-control-result@1. Throws ServiceError for what is the caller's mistake, never the authority's.
     */
    async function run(request, principal) {
        index.controlOwner(request);                       // 400 for a service Services does not read, before any row
        const actor = actorOf(principal);
        let onBehalfOf = request.on_behalf_of;
        if (principal.kind === 'user') {
            if (onBehalfOf && !(onBehalfOf.type === 'user' && onBehalfOf.id === principal.subject)) {
                throw new ServiceError(403, 'capability.denied', 'a user token acts for that person only: on_behalf_of is absent or names them');
            }
            onBehalfOf = { type: 'user', id: principal.subject };
        }
        // A person-owned resource (ADR-048 amendment 2026-10-15) is controlled by its owner: their own user token, or a
        // first-party service acting for them. Services cannot tell whose an agent is, so agents are not offered these.
        if (request.owned) {
            if (onBehalfOf && onBehalfOf.type !== 'user') {
                throw new ServiceError(403, 'control.person_only', 'a person-owned resource is controlled by its owner; agents cannot act on them yet');
            }
            if (!onBehalfOf || onBehalfOf.id !== request.owner.id) {
                throw new ServiceError(403, 'capability.denied', 'only its owner controls a person-owned resource');
            }
        }
        const forward = { ...request };
        delete forward.confirmation_id;
        if (onBehalfOf) forward.on_behalf_of = onBehalfOf;
        const action = actionOf(forward);
        const digest = digestOf(action);
        const project = request.project_id || null;
        const target = request.resource || (request.owned ? `${request.owned.kind}/${request.owned.id}` : `kind:${request.resource_kind}`);
        const key = request.idempotency_key;

        // 1) The idempotency key: claim it, replay its answer, or refuse.
        let row = await db.maybe('SELECT * FROM services_control_log WHERE idempotency_key = $1', [key]);
        let id = null;
        if (!row) {
            const logged = { ...action, params: undefined, params_sha256: request.params ? digestOf(request.params) : undefined, digest };
            id = store.newId('ctl');
            const claimed = await db.maybe(`INSERT INTO services_control_log (id, ovrn, action, actor_subject, project_id, idempotency_key, request, status, at)
                VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'pending', $8) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
            [id, request.resource || null, request.action, actor, project, key, JSON.stringify(logged), store.iso()]);
            if (!claimed) { id = null; row = await db.maybe('SELECT * FROM services_control_log WHERE idempotency_key = $1', [key]); }
        }
        if (row) {
            if (row.actor_subject !== actor || !row.request || row.request.digest !== digest) {
                throw new ServiceError(409, 'control.idempotency_conflict', 'this idempotency_key was already used for another request');
            }
            const gate = row.response && row.response.confirmation_required;
            if (request.confirmation_id && row.status === 'refused' && gate && gate.confirmation_id === request.confirmation_id) {
                // The retry of a gated request, with the confirmation it was given: claimed again by exactly one writer.
                const got = await db.maybe(`UPDATE services_control_log SET response = NULL, status = 'pending', at = $3
                    WHERE id = $1 AND status = 'refused' AND response->'confirmation_required'->>'confirmation_id' = $2 RETURNING id`, [row.id, request.confirmation_id, store.iso()]);
                if (!got) throw new ServiceError(409, 'control.in_progress', 'a request with this idempotency_key is still running');
                id = row.id;
            } else if (row.response != null) {
                await audit({ actor, target, project, detail: { action: request.action, state: row.status, control_id: row.id, replayed: true } });
                return row.response;
            } else {
                const got = await db.maybe(`UPDATE services_control_log SET at = $3 WHERE id = $1 AND response IS NULL AND at < $2 RETURNING id`,
                    [row.id, new Date(store.now() - STALE_MS).toISOString(), store.iso()]);
                if (!got) throw new ServiceError(409, 'control.in_progress', 'a request with this idempotency_key is still running');
                id = row.id;
            }
        }

        // 2) The gate and the authority. Every outcome becomes a result, so the claim is always answered.
        let result;
        try {
            result = await decide(forward, request.confirmation_id || null, onBehalfOf, digest);
        } catch (err) {
            log.error(`[Services] control ${request.action} ${target}: ${err.message}`);
            result = controlResult(forward, 'failed', { problem: { status: 500, code: 'control.internal_error', detail: 'Services could not complete this control request' } });
        }

        // 3) The record: the log row's answer and one audit row, in one transaction.
        await store.tx(async () => {
            await db.query('UPDATE services_control_log SET response = $2::jsonb, status = $3, ovrn = COALESCE(ovrn, $4) WHERE id = $1',
                [id, JSON.stringify(result), result.state, result.resource || null]);
            const detail = { action: request.action, state: result.state, control_id: id };
            if (result.problem) detail.code = result.problem.code;
            if (result.confirmation_required) detail.confirmation_id = result.confirmation_required.confirmation_id;
            else if (request.confirmation_id) detail.confirmation_id = request.confirmation_id;
            await audit({ actor, target: result.resource || target, project, detail });
        });
        return result;
    }

    return { run };
}

module.exports = { createControl, sensitiveReason, digestOf, httpStatusOf };
