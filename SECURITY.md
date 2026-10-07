# Security policy

OpenVibe is run in the open, and we want to hear about security problems before anyone else does.

## Reporting a vulnerability

Email **contact@openvibe.network** with "security" in the subject. Please include what you found, where (URL,
repository, file), how to reproduce it, and what an attacker could do with it. Do not open a public GitHub issue for
a vulnerability, and do not test against other people's accounts, projects, resources or data.

We reply within 7 days, keep you updated while we fix it, and credit you when the fix ships if you would like.

## Scope

Every OpenVibe service and site (openvibe.services, openvibe.network, openvibe.live, openvibe.media, openvibe.run,
openvibe.bot and the other openvibe.* domains) and every repository under github.com/OpenVibers. Machine-readable
contact details are at `/.well-known/security.txt` on each site.

## This service

OpenVibe.Services aggregates every authority's resource index and (from plan T13 step 10) routes control operations
to them, so a defect here can expose another project's resources or act on them. What Services guarantees, and what
a report should assume:

- **no other service's data is written.** Services never opens, writes or migrates another service's database. Its
  own rows are migrations/0001_initial.sql — the authority registry, a rebuildable read model, recipes and the
  control log.
- **a person reads only their own projects.** A Network user token is accepted only for a project the person owns or
  belongs to, verified with the caller's own token against Network's developer projects API
  (`GET /api/v1/projects/:project`); a project they are not a member of is `404`, never a `403` that confirms it
  exists. A person is never accepted unscoped, and the fan-out passes only that one project to the authorities.
- **a scoped read stays scoped.** Services filters `project` (and `kind`, `service`) on the merged rows itself, so an
  authority that ignores a query parameter cannot leak another project's resource into a person's page.
- **a service token is judged on its own claims.** Audience `openvibe.services`, `svc:` principal, capability
  `services.resource.read` (PROPOSED until plan T13 step 4 registers it — enforced with contracts' own grant rules).
  A bad token is refused, never downgraded to anonymous, and an app, mod or agent token is refused even with the
  grant: a person reads with their own user token, never through a developer app's credential.
- **no secret is stored, logged or served.** The per-authority client-credentials tokens are minted at call time,
  cached in memory with a 60 s refresh skew and never written to disk, a log line or a response body. The only route
  that shows operational detail, `GET /api/v1/authorities`, is first-party (a service token) and carries no secret.
- **a failure degrades, it never stops.** An authority or Network being down yields a partial page named in
  `X-OpenVibe-Partial-Authorities`; the rest of the index keeps serving (ADR-046 section 6).
- nothing starts at module load (the key refresher and the outbox relay start in `server/index.js` `main()`), and
  `/metrics` answers only a direct loopback caller that no proxy relayed.

## Supported versions

Only the current `main` branch, which is what runs in production, receives fixes.
