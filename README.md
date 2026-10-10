# OpenVibe.Services

> The developer platform of the OpenVibe network: one console for projects and apps over OpenVibe.Network, scoped credentials, capability grants, usage and project export; app and mod releases; API, contract, SDK and event reference generated from what production runs; OAuth and webhook tools; and one resource index over every service.

**Status:** alpha. Serves `https://openvibe.services` (openvibe-ovh, unit `openvibe-services` on 127.0.0.1:4930 behind nginx). The developer portal moved here from OpenVibe.Codes on 2026-10-08 (owner decision: Codes became the open coding-agent harness); its production data then was nil (0 manifests, 0 releases, 0 playground runs), so nothing was copied, and openvibe.codes answers its old portal paths with permanent redirects to the same paths here. Tests run against in-process stand-ins for Network, Events and Media. See [STATUS.json](STATUS.json) for exactly what works and what does not.
**Domain:** `openvibe.services` · **Port:** 4930 · **Service id:** `services`
**Plan:** plan T13 (the developer platform and the resource control plane); binding decisions ADR-014 (the portal over Network's projects API) and ADR-048 (the control plane) in OpenVibe.Contracts.
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

A place where a developer outside the network goes from an OpenVibe account to a working, scoped integration using only public docs, the SDK and their own credentials. Services is a **console**: the identity authority (OpenVibe.Network) owns projects, apps, credentials, grants and quotas (ADR-014), and Services shows and forwards what the signed-in person asks for, with that person's own Network token.

## Owns

- **Release metadata** keyed to Network app ids: validated app and mod manifests, releases (`draft → published → deprecated → revoked`), an append-only release log.
- **The merged resource index** (ADR-048, `services.resource.read`): every authority's resources, read from each one and merged, never stored as the truth; Services' own manifests (`services.manifest`, `mfs_`) and releases (`services.release`, `rel_`) are read in process. Trust tiers and playground runs are metadata and audit, never resources.
- **Trust tiers** per ADR-013 (`unreviewed`, `reviewed`, `first-party`) — **metadata only**: a tier changes defaults and discovery, never a grant check. Databases written with the earlier four names are migrated at boot (untrusted→unreviewed, verified/trusted→reviewed, platform-maintained→first-party), idempotently.
- **Playground run logs** (who ran what, outcome, stage, problem code; never a credential).
- The events `services.app.published`, `services.app.deprecated`, `services.app.revoked`, and `services.moderation.action` for staff revocations and trust tier changes (the network's moderation audit log), through the openvibe-sdk transactional outbox.
- The generated reference (rendered from the pinned packages at boot; nothing hand-written that can drift) and the console's pages.

## Does not own

- Projects, members, apps, credentials, grants, allowances, quotas, audit: **OpenVibe.Network** (`/api/v1/projects`). Services never copies them.
- Secrets: Network returns a client secret once; Services renders it in that one response (`Cache-Control: no-store`) and keeps no copy. Tests scan every table, every log line and every later response for each secret.
- Token issuance and quota enforcement: Network issues tokens; the service that owns a capability enforces its quota. Services labels quotas "recorded limit — enforced by `<service>`".
- The registry (Network) and the contracts (OpenVibe.Contracts).

## What is here

| Surface | Path | Notes |
|---|---|---|
| Portal | `/projects`, `/projects/:project`, `/projects/:project/apps/:app` | Create projects; add members; create sandbox/production apps (secret shown once); rotate and revoke credentials; request, approve, deny and revoke grants through a scope editor that offers only grantable capabilities (public, or partner when in the allowance) with each one's description, owner and visibility; quotas; **usage** (owner, admins and staff: `/projects/:project/usage?days=7|30|90&env=all|production|sandbox`, Network's `GET /api/v1/projects/:project/usage` rendered server-side: usage by service, capability and day, each recorded quota's headroom as a `<meter>`, the published limits of the services used (their `/limits.json`), errors by code and the sampled failures with their trace ids and job or event ids; the numbers come from the services' hourly `*.usage.recorded` rollups, which Network adds up per day, so the current hour is not counted yet); audit (admin+); **export** a project's metadata as one JSON document (`/projects/:project/export`: Network's project, members, apps with credential ids and hints, grants, quotas and, for admin+, audit, plus Services' releases with manifests and logs, trust tiers and playground runs; never a secret); owners and admins also download the **full archive** (`POST /projects/:project/export/archive`, one zip: that document with the audit log, the release manifests, the project's Media objects with download URLs and its namespaces, and its retained app events, for production and sandbox; read with Network's read-only export tokens; all or nothing when a service fails; [format](https://openvibe.services/docs/export)) and **delete** a project (owner, confirmed by name: Network archives it — it offers archiving, not erasure — then Services deletes drafts, their manifests and playground runs, and revokes published releases so installers are told). Network's errors are shown with its status, code, detail and request id. |
| OAuth helper | `/oauth`, `/oauth/test-callback` | Explains authorization code + PKCE (S256) for apps, builds a test authorize URL, and a callback that shows `code`/`state`/`error` and **never exchanges** the code. |
| Webhook tools | `/tools/webhooks` | Verify a delivery as a receiver that requires signature v2 does: `X-OpenVibe-Signature-V2: t=<ts>,v2=<HMAC of "<ts>.<raw body>">` must match and `t` must be within ±300 s of now (the page shows the age and the window, and tells a stale-but-correct signature from a wrong one); `X-OpenVibe-Timestamp` must equal `t`. v2 only: the v1 header (`X-OpenVibe-Signature`) was retired on 2026-09-28 and has no field. In the browser with Web Crypto, or on the server without JavaScript with openvibe-sdk's `verifyDeliveryV2`; constant-time; secret dropped. Generate a sample delivery signed as Events signs it (`X-OpenVibe-Timestamp` and v2, `signDeliveryHeaders`) for any event type the contracts catalog lists. |
| Docs | `/docs/*` | Contracts (field tables, fixtures as examples, raw schema), capability catalog (grantable ones highlighted), event types, SDK reference from its `.d.ts` files, ADRs. Every page states the versions it was generated from. The service registry is read live from Network, with health as Network reports it. |
| Playgrounds | `/projects/:project/apps/:app/playground` | Media upload (sandbox, `media.object.upload`) and Events publish (`events.app.publish`: types `app.<project_key>.*`, source `app-<app ULID>`), run **as the app** with its own token (from its secret typed for that one request, or a pasted token). Refused — with the missing grant named, and nothing requested or called — unless Network lists the grant as approved. Sandbox apps only. |
| Manifests | `/manifests/validate`, `/projects/:project/apps/:app/releases/new` | Validate `services.app-manifest@1` and `mods.mod-manifest@1` with openvibe-contracts; create, publish, deprecate and revoke releases. |
| Resource index | `GET /api/v1/resources`, `GET /api/v1/resources/:ovrn`, `GET /api/v1/authorities` | The merged index over every authority (ADR-048, `services.resource.read`): see [The merged index](#the-merged-index) below. |
| Policy | `/policy/*` | Proposal process and the decision record; compatibility and deprecation policy rendered from ADR-002 and ADR-016 as published; licensing read from package metadata; transparency (what Services stores and does not). The community documents — code of conduct, contributing, the contributor ladder and the moderation policy — are OpenVibe.Codes' (`https://openvibe.codes/policy/<slug>`); their old addresses here redirect there. |
| API | `/api/v1/*` | Public release reads (`services.release.read`: no token needed; a presented token must hold it), manifest validation, docs versions; release management by an app with its own token (`services.release.manage`); Services' own resource index (`services.resource.read`, first-party). Guarded with openvibe-contracts `requireCapability`. RFC 9457 problems. |
| Machine | `/api/health`, `/api/ready`, `/release.json`, `/metrics` | Readiness is truthful (db and docs required; Network, JWKS, OAuth client and events relay reported as optional checks). `/metrics` answers loopback callers only. |
| Crawl artifacts | `/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/llms-full.txt` | Built with openvibe-shared/seo for search and AI crawlers. robots.txt keeps every disallow (the portal, staff, sign-in and the API are not crawlable) and names the sitemap; the sitemap lists the fixed public pages with STATUS.json's content date and each public app and published release with its real publish time (never "today"); llms.txt maps the site; llms-full.txt lists every fixed public page the sitemap does, one title and one line of text each. |

Everything is server-rendered and usable without JavaScript. The only scripts of Services' own are optional: in-browser webhook verification and a copy button. The coding-harness catalog that used to sit under `/docs/harnesses` is OpenVibe.Codes' (`https://openvibe.codes/harnesses`).

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

## Depends on

- **OpenVibe.Network** — SSO (OAuth client `services`, PKCE S256), JWKS, `/api/v1/projects` (called server-side with the person's Network access token), the registry (`/api/v1/registry/services`, `/.well-known/openvibe`), client-credentials tokens (Services' own for the events relay; the app's own in playgrounds).
- **OpenVibe.Events** — the outbox relay publishes `services.app.*` with Services' service token (`events.event.publish`); the Events playground calls it with the app's token (`events.app.publish`); the project archive pulls the project's app events with a Network export token (`events.app.read`).
- **OpenVibe.Media** — the Media playground uploads with the app's token into the project's namespace; the project archive lists the project's objects, namespaces and download URLs with a Network export token (`media.object.list`, `media.object.read`).
- **PostgreSQL 18 and Valkey 9** (OpenVibe.Host `roles/data/`, ADR-035): every read and write is async through `openvibe-sdk/db`; Valkey holds the per-actor limit counters (optional).
- **openvibe-contracts v0.127.0**, **openvibe-sdk v0.35.1**, **openvibe-shared v3.0.0** (pinned tag tarballs; the docs show the tag and the package version, and say so when they differ).

No path in Services sends or accepts a shared loopback key (tested by grep and at runtime).

## Grants and registration the lead must add

Implemented here (the service manifest's `capabilities`): `services.release.read` (public release reads;
no token needed, a presented token must hold it) and `services.release.manage` (release management by an
app with its own token), both guarded with openvibe-contracts `requireCapability`; and
`services.resource.read` (the authority resource index, ADR-048: `GET /api/v1/resources` and
`GET /api/v1/resources/:ovrn`), first-party — the capability is served here, so a caller presents a
service token holding it.

Called elsewhere: as the service principal `services`, `events.event.publish` at Events (the outbox relay);
as the signed-in person, with their own Network token, Network's `/api/v1/projects`; as the app, with
its own token, `media.object.upload` (Media) and `events.app.publish` (Events) in the playgrounds; and,
for the project archive, Network's read-only export tokens holding `events.app.read`,
`media.object.list` and `media.object.read`.

In Network (`server/identity/principals.js` / `server/db/database.js`, as for coupons and host):

- OAuth client `services`, name `OpenVibe.Services`, redirect URI `https://openvibe.services/auth/callback`.
- Service grant `['services', 'events.event.publish', 'openvibe.events', []]` (the outbox relay).
- Account export and deletion (ADR-033): `['services', 'events.subscription.manage', 'openvibe.events', []]` (the two
  account subscriptions, created at boot), then, last and once the release is live,
  `network.account.export.contribute` and `network.account.deletion.confirm` for audience `openvibe.network`.

### Account export and deletion (ADR-033)

`network.account.export_requested` and `network.account.deleted` arrive at `POST /internal/events`. The route is
loopback-only (nginx answers 404 for `/internal/`, and the handler refuses a forwarded request) and signed with
`SERVICES_EVENTS_SECRET`. They are answered by `server/domain/account-data.js` over `openvibe-sdk/account-data`, with
one receipt per export and deletion in `account_data_events` (migration 0003).

- **Export:** the playground and recipe runs the person started, and the manifests and releases they created.
- **Deletion:**
  - Their runs are deleted.
  - Manifests and releases belong to their project and stay: `created_by` becomes `deleted` and the publisher,
    deprecator and reviser become NULL.
  - The resource index's owner becomes NULL.
  - The append-only release log, the control log and the staff trust tiers stay attributed, for accountability.

The Services service manifest, `services.release.manage|read`, `services.resource.read` and `services.app-manifest@1` are released in openvibe-contracts v0.127.0 (they replaced the `codes.*` forms, retired that release); the CI contracts check is blocking.

For the playgrounds to succeed end to end (not Services' code; configuration elsewhere): Network `DEV_SANDBOX_AUDIENCES` including `openvibe.media` and `openvibe.events`, a staff-set allowance containing `media.object.upload` and `events.app.publish` for the project, a Media tenant keyed by the project id, and OpenVibe.Events serving `events.app.publish` for app tokens. On 2026-09-23 these were in place on production: a sandbox app uploaded to Media (tenant `prj_…-sandbox`) and published and read app events through public endpoints. That run used curl, not the playgrounds, and it is not yet a committed, repeatable check.

## Configuration

See [.env.example](.env.example). Required in production: `OV_OAUTH_CLIENT_SECRET`, `SERVICES_FORM_SECRET`, `BASE_URL`, `DATABASE_URL` (and `DATABASE_DIRECT_URL` for the boot migrations, run as the owner). Optional: `EVENTS_URL` (relay), `INDEXNOW_KEY` (see below), `SERVICES_STAFF_SUBJECTS`, `SERVICES_PLAYGROUND_*`, `SERVICES_REGISTRY_TTL_MS`, `SERVICES_LIMITS_MINUTE` / `SERVICES_LIMITS_HOUR`.

### IndexNow (openvibe-shared/indexnow)

With `INDEXNOW_KEY` set (8–128 hex or alphanumeric characters, what IndexNow's own tools
generate), the key file is served at `/<key>.txt` as `text/plain` and every public release
transition tells the engines: publish, deprecate and revoke of a published or deprecated release
ping `api.indexnow.org` with the release page (while it is published), the app page, `/updates`
and `/sitemap.xml`; the module batches and debounces these. Nothing pings for a draft, and a
release that was never public stays silent. Unset: the feature is off — no key file, nothing sent
(what tests and drills do). The key is not a secret in the credential sense: engines fetch it by
design. `test/indexnow.test.js`.

### Per-actor limits

`/api/v1`, the console (`/projects`), release actions, the tools' forms and the staff trust form also
limit who calls them, once the caller is known and before any work (before a form or upload is read,
before Network is asked): `server/http/actor-limits.js`, openvibe-sdk/limits, roadmap WS-R task 4. An
app token counts as its app (`app:app_…`), a signed-in person as `user:usr_…`, anyone else by address.
Past a limit: `429` problem+json `rate_limited` with `Retry-After`, one `[Limits]` log line and
`services_rate_limited_total{limit,window}`. The per-address limits (pages 300 a minute, console writes 60,
tools 30, API writes 60, sign-in) and the playground's runs an hour stay. Services hosts no git remotes, so
there are no clone or push routes to leave out.

| Routes | Per caller, a minute / an hour |
|---|---|
| API reads; console pages (each asks Network with the person's token) | `SERVICES_LIMITS_MINUTE` / `SERVICES_LIMITS_HOUR` (120 / 3000) |
| Project create | 5 / 30 |
| Members, roles, archive, delete | 20 / 200 |
| Project export (JSON and the full archive) | 3 / 20 |
| App create | 10 / 60 |
| Redirect URIs, grants, app revoke | 30 / 300 |
| Credential rotate and revoke | 10 / 60 |
| Playground runs (above the 60 an hour per person) | 10 / 120 |
| Release create and "validate only" (console and API) | 20 / 200 |
| Release publish, deprecate, revoke (console and API) | 20 / 200 |
| Manifest validate (form and API); webhook verify and sample | 30 / 600 each |
| Staff trust tier | 30 / 300 |

Never limited per actor: `/api/health`, `/api/ready`, `/release.json`, `/metrics`, sign-in, and the
public pages and docs. `test/actor-limits.test.js`; the other tests boot with the per-actor limits off,
as they raise the per-address limit.

## Deploy (for the lead)

Production deploys with `sudo ovhost deploy services` on the host (strategy `git-checkout`: fetch,
fast-forward `/opt/openvibe.services`, install on a lockfile change, restart, wait for `/api/ready`).
The unit is `openvibe-services.service` on `127.0.0.1:4930`, the env file `/etc/openvibe/services.env`. The database is
`ov_services` on the host's data role (`sudo /opt/openvibe.host/roles/data/add-service.sh services` writes its settings); the
release migrates it at boot. nginx serves `openvibe.services` from
[deploy/nginx/openvibe.services.conf](deploy/nginx/openvibe.services.conf).
Rollback: ovhost puts the previous sha back by itself when `/api/ready` does not answer 2xx after the
restart; afterwards `sudo ovhost rollback services --to <sha>`. A release from before the console (the bare index,
before 2026-10-08) never reads migration 0002's tables, so a rollback across it serves the index again and the console
pages answer 404 until the next deploy.

First install (done once; kept for a rebuild):

1. `git clone` to `/opt/openvibe.services`; `npm ci --omit=dev` with Node 22.
2. `/etc/openvibe/services.env` from `.env.example` (secrets from the Network client registration).
3. `deploy/systemd/openvibe-services.service` → `/etc/systemd/system/`; `systemctl enable --now openvibe-services`.
4. `deploy/nginx/openvibe.services.conf` → `/etc/nginx/sites-available/`, certificate for `openvibe.services` + `www`, reload nginx.
5. Check `curl -s http://127.0.0.1:4930/api/ready`.
6. Only when the launch rule below holds: remove `openvibe.services` from `OpenVibe.Sites/sites.json` and switch routing (done on 2026-10-08, when the console moved here).

## Development

```bash
npm install
fnm exec --using=22.22.1 npm test          # every test/*.test.js on temp PGlite databases with mock Network, Events, Media
fnm exec --using=22.22.1 npm run dev       # http://localhost:4930
npx openvibe-contracts-check --service services --src server
```

Tests: the crawl artifacts (robots.txt, sitemap.xml, llms.txt and llms-full.txt — the public pages only, llms-full.txt listing every page the sitemap does, and lastmod from STATUS.json, never the clock); ADR-013 trust-tier migration; secrets never persisted or re-displayed; Network errors surfaced honestly (404/403/409/422/503, unreachable, expired session refresh); scope editor offers only grantable capabilities and refuses forged requests before Network sees them; generated docs match the pinned versions (every contract, capability, event type, SDK module); webhook verification, v2 only (tampering, lengths, malformed headers, the ±300 s window both ways, timestamp header mismatch, a v1-only delivery refused, samples without v1, constant-time, the in-browser verifier agreeing); playgrounds refuse without the grant and call nothing; the usage page (owner, admins and staff only, Network not asked for anyone else, filters forwarded as offered, a Network failure shown as it answered); project export (complete, no secrets, audit for admin+ only, never partial) and delete (owner only, Network first, drafts and runs removed, public releases revoked with an event); manifest validation; release lifecycle and events; the authority resource index (auth matrix — no token 401, a token without `services.resource.read` 403, with it 200 — every page and read valid against `common.resource-list-result@1`/`common.resource-summary@1`, `?project=` never returning another project's rows, `?kind=`, cursor paging, `GET /:ovrn` found and 404, a bad query 400); no internal key anywhere; PKCE sign-in; readiness, release.json, loopback metrics; the released services manifest matching the code; IndexNow (off without a key, the key file served with a key, a publish pinging the page and the sitemap, a draft never pinging); and the home page's size budgets (`test/perf-budget.test.js`, openvibe-shared/perf-budget).

## Acceptance (must be true before "done")

- A new external developer goes from account to a working Media, event and capability integration with only public docs, the SDK and scoped credentials — no loopback key. **Partly shown: one production run on 2026-09-23 covered account, project, sandbox app, auto-approved grants, Media upload and app event publish/read with public endpoints (curl, not the SDK or the playgrounds). It is not committed as a repeatable check, and it did not cover webhook delivery to an external endpoint, publishing a release or revoking credentials.**
- Credentials can be inspected, scoped, rotated and revoked. **Yes, through Network's API (tested against a stand-in; not yet used on production).**
- The playground cannot exceed its project's grants. **Yes (tested).**
- A published app or mod release carries compatibility and trust metadata. **Yes (tested).**

## Launch rule

The domain keeps its placeholder page on [OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the following exist (plan §12.12). **The portal left Sites as openvibe.codes on 2026-09-23 and moved to `openvibe.services` on 2026-10-08.** The items: an owning runtime with health/readiness and observability (**done**); canonical identity/auth integration (**done; the OAuth client `services` carries the redirect URI `https://openvibe.services/auth/callback`**); server-rendered public routes useful without JavaScript (**done**); real persistence and end-to-end workflows (**persistence done; the external-developer path ran once on production with curl, not yet through the console**); capability and event registration against OpenVibe.Contracts (**released**); a migration/seed strategy (none needed: no data is imported; raw old developer keys are never imported), a security review and sitemap/robots behaviour (**sitemap and robots done; the security review is the threat notes below, self-authored**); acceptance tests proving the advertised functionality (**against stand-ins**). Roadmap binding: do not present Services as a working developer platform where these paths are mocked.

## Security (threat notes)

Reporting a vulnerability: [SECURITY.md](SECURITY.md).

- Session tokens are httpOnly (unlike the navbar-readable `ov_token` elsewhere) because this site displays secrets; forms carry an HMAC form token and require a same-site `Origin`.
- Secrets never reach logs: errors are logged without request bodies; playground failure details are scrubbed of the credential before they are stored or shown.
- Services never fetches a URL a developer types (the webhook tester produces a `curl` for their own endpoint instead).
- Grant checks happen twice: Services refuses to forward non-grantable capabilities, and Network decides. Playgrounds verify the app token's signature, subject, project, environment, audience and capability before calling anything.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).

<!-- versions:start -->
- openvibe-contracts: v0.127.0
- openvibe-sdk: v0.37.2
- openvibe-shared: v3.0.0
<!-- versions:end -->
