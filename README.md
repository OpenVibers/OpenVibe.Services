# OpenVibe.Services

The resource control plane of the network (openvibe.services): one merged index over every authority, and — as plan
T13 lands — the console and the control operations on top of it. Design: OpenVibe.Contracts
docs/adr/ADR-048-services-control-plane.md; plan track T13.

## Purpose

Every service that owns resources answers `GET /api/v1/resources` with a `common.resource-list-result@1` page of
`common.resource-summary@1` (`ADR-048`; the resource-index sweep adds that route to each service in turn). Services is
the one place that fans out over those authorities, merges their pages, and answers a single index — so a console,
an operator or a developer sees every resource of every project they may see without any service learning another
service's schema.

**Services aggregates authorities; it never replaces one.** It reads each authority's resource index and keeps at
most a read model it can rebuild; it never opens, writes or migrates another service's database, and every control
operation (plan T13 step 10) will be a call to the authority that owns the resource. An authority, or Network, being
down degrades the index into a partial page — it never stops it (ADR-046 §6).

This repository is at plan **T13 steps 3 and 6**: the kernel and the fan-out index. The read model and ingestion
(step 7), the console (step 9), the control operations (step 10), recipes (step 11) and the usage/cost surfaces
(step 12) are not built yet; this service declares them nowhere.

## Routes

| Method and path                                   | Capability                | Request → answer |
|---------------------------------------------------|---------------------------|------------------|
| `GET /api/v1/resources?project=&kind=&service=&cursor=&limit=` | `services.resource.read` | `common.no-body@1` → `common.resource-list-result@1`, merged over every authority; an authority a page could not read is named in the body's `partial: [{ service, code }]` |
| `GET /api/v1/resources/:ovrn`                     | `services.resource.read`  | `common.no-body@1` → `common.resource-summary@1` from the authority that owns the resource (URL-encode the OVRN: it carries a `/`) |
| `GET /api/v1/authorities`                         | `services.resource.read`  | `common.no-body@1` → `{ authorities: […] }` — the registry as this instance built it. Services-local: no contract names it yet, and it is first-party (a service token, not a person) |
| `GET /api/health`, `GET /api/ready`, `GET /release.json` | none              | liveness, truthful readiness (the database and the Network signing key; a down authority is a partial page, not a red readiness), the release manifest |
| `GET /metrics`                                    | none (loopback only)      | Prometheus text, for a direct loopback caller only |

`services.resource.read` is registered in the pinned openvibe-contracts (v0.110.0: `status: active`, `visibility:
first-party`). Contracts' manifest and grant rules (`capabilities.check`, wildcards included) decide it, and an id
contracts does not know is refused, never allowed. `services.resource.control` arrives with step 10.

Errors are RFC 9457 `application/problem+json`: `400 resources.bad_query | resources.bad_name |
resources.unknown_service | resources.project_required`, `401 token.missing`, `403 capability.denied`,
`404 resources.not_found`, `502 resources.authority_unavailable | resources.authority_error |
resources.authority_bad_response`, `503 network.unavailable | identity.unavailable`.

## Who may read the index

- **A Network service token** for audience `openvibe.services`, `svc:` principal, holding `services.resource.read`
  (first-party): the whole index, over every authority and every project; `?project=` only narrows it. An app, mod
  or agent token is refused even if it somehow holds the grant — a person reads with their own user token, never
  through a developer app's credential.
- **A person's Network user token**: only projects that person owns or belongs to, and only ONE at a time —
  `?project=prj_…` (or the OVRN's own project) is required, and Network answers the membership question
  (`GET /api/v1/projects/:project`, the developer projects API) with the caller's own token. A project the person is
  not a member of is `404 resources.project_not_found`, the same non-disclosure Network itself uses — never a `403`
  that would confirm the project exists. A person is never accepted unscoped.

`GET /api/v1/authorities` is first-party operational data (loopback origins) and answers only a service token.

## The merged index

The fan-out, each authority's opaque-cursor walk and the merge are `openvibe-sdk/resources`' `createResourceIndex`
(SDK v0.34.0, `docs/service.md` §"The resource index and the control plane") — Services does not reimplement any of
it. Services adds:

- **the authority set** — one adapter per authority (`server/authorities/adapter.js`), each calling that authority's
  loopback origin with its own Network client-credentials token (`server/authorities/tokens.js`: one cached token per
  audience, scoped to that authority's `resource.read` capability, refreshed 60 s before expiry);
- **a deterministic total order** over the merged resources (service, OVRN, id) and an opaque keyset cursor into it,
  so a page walk repeats nothing and skips nothing while the underlying data is stable;
- **local filters** for `project`, `kind` and `service` on top of the authorities' own answers: a scoped read (a
  person's, above all) never shows a row outside its scope even if an authority ignores a query parameter;
- **the partial answer**. `common.resource-list-result@1`'s `partial` array (contracts 1.1.0) names the authorities
  a page could not read, each with the problem code it answered: a page whose fan-out was incomplete omits those
  rows and carries `partial: [{ service, code }]`, and a complete page carries no `partial` key at all. The code is
  the authority's own problem code when it answered one, and Services' own `resources.authority_timeout` /
  `resources.authority_unavailable` when nothing answered (a timeout, or a network or token-mint failure) — nothing
  new is registered in contracts.

An authority is never required to answer for the index to answer: a timeout (default 5 s per authority), a refusal,
a malformed page or a Network that cannot mint its token makes that authority partial and leaves the rest of the page
intact.

## The authority registry

`server/authorities/index.js` builds the registry at boot from the **pinned openvibe-contracts service manifests**:
every service whose manifest lists `<id>.resource.read` **and** whose capability manifest says `status: active` is an
authority. With contracts v0.110.0 that is **network, events, host, codes and media** (services.resource.read is
Services' own id, and Services is never its own authority); the moment a service's manifest turns that on, it is in
the registry on the next boot, and nothing here is hand-maintained. Each authority's loopback origin comes from its
manifest (`internalOrigin`); `SERVICES_<ID>_URL` overrides one for the operator. The audience Services mints for is
`openvibe.<id>`.

There is no polling loop: the index reads the authorities on each request (step 6). The rebuildable read model and
`*.resource.*` ingestion are step 7.

## Owns

- The authority registry (derived from the pinned Contracts manifests, not stored) and the merged resource index.
- Its own database (ADR-035): `migrations/0001_initial.sql` — `services_authorities`, `services_resources`,
  `services_catalog_entries`, `services_recipes`, `services_recipe_runs`, `services_control_log`,
  `services_events_outbox`. All of it is the console's own state or a read model it can rebuild; no table is another
  service's.

## Does not own

- Any other service's rows, bytes, grants, events or decisions: every resource belongs to its authority, and every
  control operation (step 10) will be a `common.resource-control-request@1` to that authority.
- Identity, projects, apps, keys and nodes: OpenVibe.Network. Services asks Network's developer API with the caller's
  own token and never caches a membership decision beyond the request.
- The persons and tokens themselves: Services verifies the tokens it is the audience of (`openvibe.services`) and
  passes a user token through to Network only for the membership question.

## Depends on

- PostgreSQL 18 (ADR-035): `migrations/` applies at boot on the owner role; the service then serves on the pooled
  runtime role. Unset in development: PGlite in `data/pglite`.
- OpenVibe.Network: the RS256 signing key (`GET /api/.well-known/jwks`), Services' OAuth client (`services`) for the
  per-authority tokens, and the developer projects API for membership.
- The authorities: network (`http://127.0.0.1:4000`), media (4100), events (4300), codes (4900), host (4910) at the
  current pin. Every one of them is optional to serve, by design.
- `openvibe-contracts` v0.110.0, `openvibe-sdk` v0.34.0, `openvibe-shared` v2.12.0 (package.json).

## Tests

```bash
npm test                       # every file on PGlite, one process at a time
npm run test:pg                # the same on PostgreSQL + PgBouncer containers
node test/index.test.js        # one file
```

No test needs the network or a running service: `test/helpers/stubs.js` is an in-process OpenVibe.Network (JWKS,
`/oauth/token` with every mint recorded, project membership) and in-process authorities whose pages, timeouts and
refusals the tests drive. The index tests cover the merged page walk with a stable cursor, the filters, the
person-scoped path (including an authority that ignores `?project=`), a hanging and a refusing authority, the OVRN
route, the malformed-name and unknown-service refusals, and one token mint per authority.

## Deployment

`deploy/systemd/openvibe-services.service` (WorkingDirectory `/opt/openvibe.services`, EnvironmentFile
`/etc/openvibe/services.env`, PORT 4930) and `deploy/nginx/openvibe.services.conf`. Not deployed yet: no DNS, no
`ovhost` entry, no `ov_services` database and no `/etc/openvibe/services.env`. The first deploy needs Services'
Network client (`OV_OAUTH_CLIENT_ID=services` with its secret) granted every authority's `<id>.resource.read` scope —
otherwise every authority refuses and the index is partial (correctly, and visibly).

## Versions

<!-- versions:start -->
- openvibe-contracts: v0.112.0
- openvibe-sdk: v0.34.0
- openvibe-shared: v2.12.0
<!-- versions:end -->
