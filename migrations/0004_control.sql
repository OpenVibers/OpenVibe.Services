-- phase: expand
-- Control operations (ADR-048, plan T13 step 10): POST /api/v1/resources/control. services_control_log (migration 0001)
-- already holds one row per idempotency key: the request (params as a digest only), the answer and its state. This adds
-- the console's per-project read of that log, and services_audit: one row per control request Services accepted
-- (a replay of an idempotency key too), naming who asked, what, for which project and what came of it. Neither table
-- holds a credential, a token or the request's params (test/secrets.test.js); the authorities' own audit stays theirs.

CREATE INDEX IF NOT EXISTS services_control_log_project_at ON services_control_log (project_id, at DESC);

CREATE TABLE IF NOT EXISTS services_audit (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at          timestamptz NOT NULL DEFAULT now(),
    actor       text NOT NULL,                       -- user:usr_… or svc:…
    action      text NOT NULL,                       -- resource.control
    target      text NOT NULL,                       -- the OVRN, or kind:<service.type> for create
    project_id  text NOT NULL,
    detail      jsonb NOT NULL DEFAULT '{}'::jsonb   -- control action, state, problem code, control-log id, replayed
);
CREATE INDEX IF NOT EXISTS services_audit_project_at ON services_audit (project_id, at DESC);
