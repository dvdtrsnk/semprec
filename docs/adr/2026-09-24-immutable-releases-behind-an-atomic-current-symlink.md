---
status: accepted
date: 2026-09-24
area: [cross-cutting]
supersedes: []
superseded-by: null
---

# Immutable releases behind an atomic `current` symlink, migrated before activation

## Context

The service units from #176 already run from `/opt/semprec/current` and load secrets only from
`/opt/semprec/shared/.env` (#175). Issue #190 adds the step that puts code there, from a release tag
created under [[2026-09-24-monorepo-release-tag-from-guarded-command]].

The alternatives were updating one checkout in place (`git pull` plus a rebuild in the directory
the services run from, so a failed build or install leaves the running code half-replaced and there
is nothing to go back to), or container images (a registry, an image build pipeline and a second
runtime model next to the systemd units that already exist). Each release also needs a version
the processes can report, and the migrations need a superuser connection that no running service
should hold.

## Decision

`deploy/deploy.sh <tag>` is the only way code reaches production:

- **Immutable release per tag.** The tagged commit (annotated tag, reachable from `main`) is
  exported with `git archive` — not checked out, so nothing can pull into it — into a hidden
  staging directory under `releases/`, installed with `pnpm install --frozen-lockfile` (packages
  copied, not hard-linked to the store) and built there. It becomes `releases/<tag>` only after
  the build and the migrations succeeded. An existing `releases/<tag>` is never rebuilt or
  overwritten.
- **Migrations before activation.** The new release's migrations CLI runs while the previous
  release still serves traffic. That is safe only because migrations are forward-only and
  backward-compatible ([[2026-09-10-expand-contract-forward-only-migrations]]).
- **Atomic activation.** `current` is replaced by `rename(2)` of a freshly created symlink, so it
  names either the old or the new complete release, never a partial one. Any failure before this
  step removes the staging directory and restarts nothing.
- **Restart, then report.** After the swap every long-running service and every active
  `semprec-mailsync@` instance is restarted, and the deploy fails unless each running process
  carries the new tag as `APP_VERSION`.
- **Secrets stay in `shared/`.** The one release-specific value, `APP_VERSION`, is written to
  `releases/<tag>/release.env`, which every unit loads after the shared `.env`. The migrations run
  in a transient `systemd-run` unit whose `EnvironmentFile=` is the shared `.env`, using its
  `SEMPREC_MIGRATE_DATABASE_URL`; the script itself never reads or copies that file.

## Consequences

- A deploy that fails before activation changes nothing but the database schema, and that change
  is compatible with the release still running.
- Every prior release stays on disk as a complete directory, which a rollback can repoint
  `current` to without building anything.
- A failure after the swap (a service that does not restart or reports another version) is
  reported with a non-zero exit, but `current` already names the new release; the deploy does not
  roll itself back.
- Old releases accumulate under `releases/` until something prunes them.
- Unit files changed to load `release.env`, so a host provisioned before this needs
  `provision.sh` rerun, and its existing shared `.env` needs `SEMPREC_MIGRATE_DATABASE_URL` added
  by hand, since provisioning never rewrites it.
