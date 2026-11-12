# AGENTS.md — OpenVibe.Services

## Project overview

OpenVibe.Services is the network's developer platform and resource control plane, served at
`https://openvibe.services`. It is one console and API over OpenVibe.Network's projects, apps,
credentials, grants and quotas; it also owns release metadata, the authority registry and the merged
resource index, and (step 10) control operations routed to the authority that owns a resource.

- **Entry:** `server/index.js` (`node server/index.js`); Express app in `server/app.js`.
- **Port / service id:** `127.0.0.1:4930`, id `services`; unit `openvibe-services.service`.
- **Portal:** `server/http/portal.js` (`/projects`, `/projects/:project/resources`, `/secrets`,
  `/usage`, `/export`, `/apps/:app`), `server/http/mod.js`, `server/http/tools.js`.
- **API and machine routes:** `server/http/api.js` (`/api/v1`), `server/http/openapi.js`,
  `server/http/network-mcp.js` (`/mcp`), `server/http/discovery.js` (robots/sitemap/llms).
- **Generated docs:** `server/docs/`, `server/http/docs.js`, `server/http/ai-docs.js`,
  `server/http/money-docs.js` — generated from the pinned contracts, capability catalog, SDK
  `.d.ts` files and ADRs at boot; never hand-written where it can drift.
- **Resource index / control:** `server/resources.js`, `server/authorities/index.js`,
  `server/registry/`, `server/domain/`; SDK `openvibe-sdk/resources` does the fan-out and merge.
- **Pages:** server-rendered through `openvibe-shared/shell`; the only own scripts are the optional
  in-browser webhook verifier and a copy button. No SPA, no build step.

## Owns, does not own

Owns: release metadata keyed to Network app ids (validated `services.app-manifest@1` and
`mods.mod-manifest@1`; releases `draft → published → deprecated → revoked` and an append-only log);
the merged resource index (`services.resource.read`, read live from every authority, never stored as
truth); trust tiers (metadata only); playground run logs; the events `services.app.published`,
`services.app.deprecated`, `services.app.revoked` and `services.moderation.action`; the generated
reference and the console pages.

Does not own: projects, members, apps, credentials, grants, allowances, quotas or audit — those are
OpenVibe.Network (`/api/v1/projects`), and Services never copies them. Secrets are Network's:
Services renders a secret only once, never stores, logs or re-displays it. Identity, billing and
moderation stay with their services.

## Who calls it, what it calls

Developers and first-party services use the console and the public API; SDK
`openvibe-sdk/projects` and `openvibe-sdk/resources` are the client surface, and the MCP server at
`/mcp` exposes the network's read-only tools. Services calls:

- **Network** — SSO (`services`, PKCE S256), JWKS, `/api/v1/projects` with the person's own access
  token, the registry, client-credentials tokens, and `/internal/confirmations` for sensitive
  control operations.
- **Events** — the outbox relay publishes `services.app.*` with Services' service token; playgrounds
  publish with the app's own token; the project archive reads app events with an export token.
- **Media** — playground uploads with the app's token; the project archive lists objects and
  namespaces with an export token.
- **Authorities** — the registry is built at boot from the pinned `openvibe-contracts` service
  manifests (every service whose manifest lists `<id>.resource.read`); the loopback origin comes from
  the manifest, `SERVICES_<ID>_URL` overrides it. No polling loop: each request reads the
  authorities.

The authority registry is not hand-maintained: turning a capability on in a service's manifest puts
it in the registry on the next boot.

## Database and migrations

PostgreSQL `ov_services` (ADR-035) via `openvibe-sdk/db`: `DATABASE_URL` (PgBouncer) for the app,
`DATABASE_DIRECT_URL` for migrations. `server/db.js` applies `migrations/NNNN_*.sql` at boot under an
advisory lock, then serves with the pooled role; a held migration is logged and does not crash the
service. Never edit a migration that has run; a new table/column is an expand migration and removal
waits for a contract migration. Valkey is optional and holds only per-actor limit counters.
`telemetry_samples` is this service's own table, pruned after 14 days.

## Auth

Network RS256 JWTs (JWKS) plus the SSO session cookie. Service tokens carry `openvibe.services`
audience and the route's capability (`services.release.read`, `services.release.manage`,
`services.resource.read`, `services.resource.control`); a person's user token is used only for the
person's own projects and the pages. The index answers a first-party service token, or one project
at a time for a person who owns or belongs to it — never unscoped, and a non-member project is the
same 404 Network uses. `/api/v1/authorities` is first-party loopback data. Sensitive control
operations require Network's confirmation; until the grant exists they fail with
`confirmations.unavailable` and nothing is applied. No path sends or accepts a shared loopback key.

## Deploy

`sudo ovhost deploy services` (git-checkout: fetch, fast-forward `/opt/openvibe.services`, install on
a lockfile change, restart, wait for `/api/ready`; rollback `sudo ovhost rollback services --to <sha>`).
Unit `deploy/systemd/openvibe-services.service`, env `/etc/openvibe/services.env`, nginx
`deploy/nginx/openvibe.services.conf`, database `ov_services`. The release migrates at boot. A
rollback across the console migration serves the old index and the console pages answer 404 until
the next deploy.

## Commands and tests

```bash
npm install
npm run dev                                  # http://localhost:4930
npm test                                     # PGlite, in-process stub Network/Events/Media
npm run test:pg                              # the same on the PostgreSQL containers
npm test -- index scaffold                   # only matching files
npx openvibe-contracts-check --service services --src server
```

`test/run.js` uses `openvibe-shared/test-runner` (180 s, serial); each file gets a temp database and
stubs, never the network. The suite covers the crawl artifacts and their `lastmod` source, the
ADR-013 trust-tier migration, secrets never stored or re-displayed, honest Network errors, the scope
editor, generated docs matching the pins, v2-only webhook verification, playground grants, usage and
resource pages, project export/delete, the resource index auth matrix and cursors, readiness/metrics,
and the home page's size budgets (`test/perf-budget.test.js`).

## Conventions

- CommonJS, 4-space indent, single quotes, semicolons. Server-rendered HTML; escape every value
  (names, problem details, OVRNs) and keep pages usable without JavaScript.
- RFC 9457 problem+json for API errors (`openvibe-contracts`); render Network's status/code/detail
  and request id rather than inventing a friendlier error.
- Guard routes with `openvibe-contracts` `requireCapability`; do not hand-roll a grant check.
- Anything generated (docs, OpenAPI, manifests, sitemap/llms) is rendered from the pinned packages
  and `STATUS.json`, with the versions shown; never patch the output by hand.
- A release is validated against the pinned contracts before it is stored; publish/deprecate/revoke
  are state transitions with an event, not direct row edits.

## Key pitfalls

- **Never persist or re-display a secret.** Network returns a client secret once; Services passes it
  through and drops it. The export archive must contain no secret — tests assert both.
- **A person's resource read is never unscoped.** `?project=` is required for a user token, Network
  answers membership, and another project's rows must not appear even if an authority ignores
  `?owner=`.
- **Trust tiers are metadata**, not a grant check: changing a tier never widens access.
- **The merged index is not stored as truth.** Read the authorities per request; a failed authority
  is named in `stale`, never silently dropped or fatal.
- **Control operations need the Network confirmation** and the authority's own capability; a gated
  action without the grant fails closed.
- **Trust the pinned versions:** docs, manifest validation and compatibility pages all come from
  `openvibe-contracts`/`openvibe-sdk`; bump the pins instead of copying their content.
