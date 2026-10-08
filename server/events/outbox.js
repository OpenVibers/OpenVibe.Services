'use strict';

/**
 * Services → OpenVibe.Events through the openvibe-sdk transactional outbox (ADR-004).
 *
 *   services.app.published    a release became public            subject { type: 'app', id: app_… }
 *   services.app.deprecated   a public release was deprecated    (payload: release id, version, kind,
 *   services.app.revoked      a public release was revoked        environment, trust tier, reason…)
 *   services.moderation.action  Services staff acted on someone else's app: revoked a release they
 *                          could not manage as a member, or set a trust tier (ADR-022, for
 *                          Network's moderation audit log; subject { type: 'moderation_action' })
 *
 * emit() runs inside the PostgreSQL transaction that makes the change, so an event exists if and only
 * if its change committed. The relay publishes with Services' OWN service token (events.event.publish,
 * audience openvibe.events) only when EVENTS_URL and OV_OAUTH_CLIENT_SECRET are set; otherwise rows
 * wait in services_events_outbox and /api/ready reports the relay as off. Payloads never carry a secret.
 * The control operations of plan T13 step 10 add their audit types here.
 */
const { createServiceOutbox } = require('openvibe-sdk/events');

const TABLE = 'services_events_outbox';   // migrations/0001_initial.sql
const ACTOR = { type: 'service', id: 'services' };
const EVENT_TYPES = ['services.app.published', 'services.app.deprecated', 'services.app.revoked', 'services.moderation.action'];

function createServicesOutbox({ db, config, fetchImpl, now, log = console }) {
    return createServiceOutbox({
        db,
        source: 'services',
        table: TABLE,
        eventsUrl: config.events.enabled ? config.events.url : '',
        networkInternalUrl: config.network.internalUrl,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        intervalMs: config.events.intervalMs,
        log,
        eventTypes: EVENT_TYPES,
        autoDiscover: false,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
        ...(now ? { now } : {}),
    });
}

module.exports = { createServicesOutbox, TABLE, ACTOR, EVENT_TYPES };
