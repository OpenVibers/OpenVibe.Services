-- phase: expand
-- OpenVibe.Services' own rows (ADR-048, plan T13). Services aggregates authorities and owns no other
-- service's data: every table here is the console's own state or a read model it can rebuild from the
-- authorities' resource indexes and events. No table here is another service's, and Services never
-- opens, writes or migrates another service's database.
--
-- Nothing in this migration is another authority's truth:
--   services_authorities      the authority registry's own record (id, origin, trust, last seen); the
--                             registry Services serves is built at boot from the released
--                             openvibe-contracts service manifests (server/authorities/index.js) and
--                             uses this table only to remember what it has seen (plan T13 step 7+).
--   services_resources        the rebuildable read model of resources other services own (step 7).
--   services_catalog_entries  the product catalog move out of OpenVibe.Sites (step 14).
--   services_recipes, services_recipe_runs  onboarding recipes (step 11).
--   services_control_log      one row per control operation Services routed to an authority (step 10);
--                             the authority's own answer is the truth, this is the console's record.
--   services_events_outbox    the openvibe-sdk transactional outbox; Services declares no event type
--                             yet (step 10), so the relay is idle and rows would wait here.
CREATE TABLE IF NOT EXISTS services_authorities (
    id               text PRIMARY KEY,                  -- contracts service id: network, media, events, host, codes, …
    name             text NOT NULL,
    public_origin    text,
    internal_origin  text NOT NULL,
    manifest_version text NOT NULL,
    contracts_range  text,
    trust            text NOT NULL DEFAULT 'first-party' CHECK (trust IN ('first-party','partner','community','external')),
    status           text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','up','degraded','down','draining')),
    last_seen_at     timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS services_resources (
    ovrn                 text PRIMARY KEY,               -- common.resource-name@1
    service              text NOT NULL REFERENCES services_authorities(id),
    project_id           text NOT NULL,
    kind                 text NOT NULL,                  -- <service>.<type>
    resource_id          text NOT NULL,
    name                 text,
    state                text NOT NULL,
    owner_subject        text,
    usage                jsonb NOT NULL DEFAULT '{}'::jsonb,
    links                jsonb NOT NULL DEFAULT '{}'::jsonb,
    authority_updated_at timestamptz,
    seen_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS services_resources_project_idx ON services_resources (project_id, kind, ovrn);
CREATE INDEX IF NOT EXISTS services_resources_service_idx ON services_resources (service, seen_at);
CREATE TABLE IF NOT EXISTS services_catalog_entries (
    id         text PRIMARY KEY,                         -- product domain slug
    domain     text NOT NULL,
    status     text NOT NULL CHECK (status IN ('live','planned','parked')),
    product    jsonb NOT NULL,                           -- registry.product@1
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS services_recipes (
    id          text PRIMARY KEY,
    name        text NOT NULL,
    version     integer NOT NULL DEFAULT 1,
    description text NOT NULL,
    steps       jsonb NOT NULL,                          -- [{ id, authority, action, params, needs[] }]
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS services_recipe_runs (
    id          text PRIMARY KEY,                        -- rcp_<ULID>
    recipe_id   text NOT NULL REFERENCES services_recipes(id),
    project_id  text NOT NULL,
    subject     text NOT NULL,
    state       text NOT NULL CHECK (state IN ('running','done','failed','cancelled')),
    steps       jsonb NOT NULL DEFAULT '[]'::jsonb,
    started_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);
CREATE TABLE IF NOT EXISTS services_control_log (
    id              text PRIMARY KEY,                    -- ctl_<ULID>
    ovrn            text,
    action          text NOT NULL,
    actor_subject   text NOT NULL,
    project_id      text,
    idempotency_key text NOT NULL,
    request         jsonb NOT NULL,
    response        jsonb,
    status          text NOT NULL CHECK (status IN ('done','pending','refused','failed')),
    at              timestamptz NOT NULL DEFAULT now(),
    UNIQUE (idempotency_key)
);
-- The openvibe-sdk outbox shape (outboxSchema('services_events_outbox')): written inside the change's
-- own transaction when Services has an event to emit, relayed to OpenVibe.Events.
CREATE TABLE IF NOT EXISTS services_events_outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        text NOT NULL UNIQUE,
    envelope        jsonb NOT NULL,
    traceparent     text,
    created_at      bigint NOT NULL,
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at         bigint,
    seq             bigint,
    rejected_at     bigint,
    last_error      text
);
