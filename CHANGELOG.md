# Changelog

Notable changes to OpenVibe.Services. The service is unreleased; everything below is `0.1.0` in progress.

## Unreleased

### Added

- The repository kernel (plan T13 step 3): `server/config.js` on port 4930, `server/db.js` (PGlite in
  development, PostgreSQL through PgBouncer in production), `server/app.js`, `server/index.js`,
  `server/network.js` (the Network key provider, user-token verification, project membership),
  `server/auth.js` (`services.resource.read` in a `PROPOSED` set — plan T13 step 4 registers it),
  `server/observability.js` (`/api/health`, truthful `/api/ready`, loopback-only `/metrics`),
  `server/events/outbox.js` (idle: no `services.*` event type is registered yet),
  `migrations/0001_initial.sql` (the seven tables Services owns), `STATUS.json`, the nginx vhost and the
  systemd unit.
- The authority registry (plan T13 step 6, `server/authorities/index.js`): built at boot from the pinned
  openvibe-contracts service manifests — every non-placeholder service whose manifest lists an `active`
  `<id>.resource.read` capability, with its manifest `internalOrigin` (`SERVICES_<ID>_URL` overrides) and
  audience `openvibe.<id>`. With contracts v0.108.0: network, events, host, codes, media. Services itself is
  never an authority.
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
  fails the page; its rows are omitted and it is named in `X-OpenVibe-Partial-Authorities`
  (ADR-046 section 6). `common.resource-list-result@1` has no field for it; the contract gap is recorded in the
  README.
- The person-facing path: a Network user token reads only projects the person owns or belongs to, one at a time,
  with membership answered by Network's developer projects API using the caller's own token (non-members get the
  same 404 Network gives). Never an unscoped person, and never through an app, mod or agent token — the service
  path is `svc:` principals holding `services.resource.read` only.

### Notes

- Services aggregates authorities and owns no other service's rows (ADR-048): it never opens, writes or migrates
  another service's database, and every control operation (plan T13 step 10) will be a call to the owning
  authority.
- `services.resource.read` is not registered in openvibe-contracts yet; it is enforced from the `PROPOSED` set in
  `server/auth.js` with contracts' own grant rules, so step 4 registers exactly what this service enforces.
- The repository is not deployed; the first deploy needs `ovhost`'s inventory, the `ov_services` database,
  `/etc/openvibe/services.env` and `openvibe.services` DNS (see STATUS.json).
