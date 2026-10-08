# Changelog

Notable changes to OpenVibe.Services. The service is unreleased; everything below is `0.1.0` in progress.

## Unreleased

### Changed

- **The developer portal moved here from OpenVibe.Codes** (owner decision 2026-10-08; Codes became the open coding-agent
  harness). Services is now the developer platform at `https://openvibe.services`: the console over Network's
  projects API (projects, members, apps, credentials shown once, grants through the scope editor, usage, audit,
  project export, the full archive and delete), app and mod releases with trust tiers and their public pages,
  grant-respecting playgrounds, the generated reference (`/docs`: API explorer, contracts, capabilities, events,
  SDK, ADRs, limits, billing policy, export format), the OAuth helper, the webhook tester, manifest validation, the
  policy pages, Network SSO with PKCE, and the crawl artifacts. The code is Codes' as it ran, renamed: capabilities
  `services.release.read|manage`, events `services.app.*` and `services.moderation.action`, kinds `services.manifest`
  and `services.release`, schema `services.app-manifest@1` (openvibe-contracts v0.113.0, which retired the `codes.*`
  forms); environment `SERVICES_*` for the console's settings; cookies `services_at`/`services_rt`. Production data in
  Codes was nil, so nothing is copied: migration `0002_console.sql` creates the console's tables.
- Services' own manifests and releases join the merged index in process (`server/registry/self-authority.js`); the
  index's tokens are verified with the key their header names (the SDK's JWKS client, shared with sign-in).
- One key store (`server/auth/keys.js`, openvibe-sdk/auth) replaces the index's own JWKS loader; `OV_NETWORK_PUBLIC_KEY`
  is gone.
- The code-of-conduct, contributing, contributor-ladder and moderation documents stay with OpenVibe.Codes, where
  OpenVibe itself is built; `/policy/<slug>` redirects there, and the coding-harness catalog is Codes' too.
- openvibe-contracts v0.113.0, openvibe-sdk v0.35.1, openvibe-shared v2.13.3.

## Earlier (unreleased kernel)

### Added

- The repository kernel (plan T13 step 3): `server/config.js` on port 4930, `server/db.js` (PGlite in
  development, PostgreSQL through PgBouncer in production), `server/app.js`, `server/index.js`,
  `server/network.js` (the Network key provider, user-token verification, project membership),
  `server/auth.js` (`services.resource.read`, registered in the pinned openvibe-contracts as active and
  first-party, so contracts' manifest decides it),
  `server/observability.js` (`/api/health`, truthful `/api/ready`, loopback-only `/metrics`),
  `server/events/outbox.js` (idle: no `services.*` event type is registered yet),
  `migrations/0001_initial.sql` (the seven tables Services owns), `STATUS.json`, the nginx vhost and the
  systemd unit.
- The authority registry (plan T13 step 6, `server/authorities/index.js`): built at boot from the pinned
  openvibe-contracts service manifests — every non-placeholder service whose manifest lists an `active`
  `<id>.resource.read` capability, with its manifest `internalOrigin` (`SERVICES_<ID>_URL` overrides) and
  audience `openvibe.<id>`. With contracts v0.110.0: network, events, host, codes, media (services.resource.read is
  Services' own id; Services itself is never an authority).
- One adapter per authority (`server/authorities/adapter.js`) and the per-authority token
  (`server/authorities/tokens.js`): `GET /api/v1/resources` and `GET /api/v1/resources/:ovrn` over the
  authority's loopback origin with a Network client-credentials token for its audience, scoped to its
  `resource.read` capability and cached (one mint per authority).
- The merged resource index (plan T13 step 6): `GET /api/v1/resources?project=&kind=&service=&cursor=&limit=`
  fans out and merges every authority's pages with `openvibe-sdk/resources`' `createResourceIndex`, adds a
  deterministic (service, OVRN, id) order and an opaque keyset cursor, and filters the merged rows itself so a
  scoped read stays scoped. `GET /api/v1/resources/:ovrn` resolves the OVRN with contracts' one parser and asks
  the authority that owns it. `GET /api/v1/authorities` lists the registry (first-party).
- Partial pages: a slow, refusing or unreachable authority — or a Network that cannot mint its token — never
  fails the page; its rows are omitted and it is named in the body's `partial: [{ service, code }]`
  (`common.resource-list-result@1`, added in contracts 1.1.0), the code being the problem code the authority
  answered or Services' own `services.authority_timeout` / `services.authority_unavailable` when nothing answered
  (ADR-046 section 6). A complete page carries no `partial` key.
- The person-facing path: a Network user token reads only projects the person owns or belongs to, one at a time,
  with membership answered by Network's developer projects API using the caller's own token (non-members get the
  same 404 Network gives). Never an unscoped person, and never through an app, mod or agent token — the service
  path is `svc:` principals holding `services.resource.read` only.

### Notes

- Services aggregates authorities and owns no other service's rows (ADR-048): it never opens, writes or migrates
  another service's database, and every control operation (plan T13 step 10) will be a call to the owning
  authority.
- `services.resource.read` is registered in the pinned openvibe-contracts (active, first-party); `server/auth.js`
  lets contracts' own manifest and grant rules decide it, and an id contracts does not know is refused.
- The repository is not deployed; the first deploy needs `ovhost`'s inventory, the `ov_services` database,
  `/etc/openvibe/services.env` and `openvibe.services` DNS (see STATUS.json).
