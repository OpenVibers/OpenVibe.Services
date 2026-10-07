'use strict';

/**
 * Services → OpenVibe.Events through the openvibe-sdk transactional outbox (ADR-004).
 *
 * Services declares no event type yet: ADR-048 puts its control operations and their audit in plan T13
 * step 10, and no `services.*` event is registered in the pinned openvibe-contracts. The outbox is built
 * anyway — the table (services_events_outbox), the relay and Services' own OAuth client — so the first
 * registered type is one string in EVENT_TYPES; until then emit() refuses every envelope and the relay
 * has nothing to send. A row would be written inside the transaction that makes the change, and the
 * relay publishes with Services' service token (events.event.publish, audience openvibe.events).
 */
const { createServiceOutbox } = require('openvibe-sdk/events');

const TABLE = 'services_events_outbox';   // migrations/0001_initial.sql
const ACTOR = { type: 'service', id: 'services' };
const EVENT_TYPES = [];

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
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
        ...(now ? { now } : {}),
    });
}

module.exports = { createServicesOutbox, TABLE, ACTOR, EVENT_TYPES };
