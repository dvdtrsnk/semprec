---
status: accepted
date: 2026-09-28
area: [cross-cutting]
supersedes: [2026-09-24-immutable-releases-behind-an-atomic-current-symlink]
superseded-by: null
---

# Deploys restart only the long-running services; mail live-sync is a subsystem of `semprec-api`

## Context

[[2026-09-24-immutable-releases-behind-an-atomic-current-symlink]] made `deploy/deploy.sh <tag>` the
only way code reaches production and, after the atomic `current` swap, restarted every
long-running service plus every active `semprec-mailsync@` instance, failing unless each running
process reported the new tag as `APP_VERSION`.

That template unit never had a composition root behind it: no `semprec-mailsync` service exists
in `backend/services/`. Issue #650 hosts the mail live-sync root inside `semprec-api` instead
(`backend/services/semprec-api/src/serve.ts`), started during process startup and stopped by its
graceful shutdown before the queue runner. Keeping the `semprec-mailsync@` unit and its
restart step would leave the deploy procedure describing, restarting and health-checking a
process that cannot run. The alternative — a standalone mail-sync service — would add a unit, a
database role and a second process owning mailbox sync state for a single-user system, with
nothing the in-process root cannot already do.

## Decision

Everything in [[2026-09-24-immutable-releases-behind-an-atomic-current-symlink]] stands —
immutable per-tag releases, migrations before activation, atomic activation, secrets in `shared/`
with `APP_VERSION` in `releases/<tag>/release.env` — except the restart step, which becomes:

- **Restart, then report.** After the swap every long-running service in `LONG_RUNNING_SERVICES`
  (`deploy/deploy.sh`) is restarted, and the deploy fails unless each running process carries the
  new tag as `APP_VERSION`. There is no `semprec-mailsync@` unit and no per-mailbox instance to
  restart.
- **Mail live-sync runs inside `semprec-api`.** It restarts, reports its version and shuts down
  with that process; it is not a separately deployed or health-checked service.

## Consequences

- Restarting `semprec-api` also restarts mail live-sync; a deploy cannot restart one without the
  other.
- `provision.sh` no longer installs a `semprec-mailsync@` unit, and neither the deploy nor the
  rollback path restarts or checks one. A host provisioned before this change may still carry the
  old unit file and any enabled instances; those are removed by hand.
- If mail sync ever needs its own process (isolation, independent scaling), that is a new
  decision superseding this one, not a unit reintroduced silently.
- The remaining consequences of
  [[2026-09-24-immutable-releases-behind-an-atomic-current-symlink]] (no self-rollback after the
  swap, releases accumulating under `releases/`) are unchanged.
