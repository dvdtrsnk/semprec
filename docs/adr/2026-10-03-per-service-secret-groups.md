---
status: accepted
date: 2026-10-03
area: [cross-cutting]
supersedes: []
superseded-by: null
---

# Production secrets are split into groups, and each unit loads only its own

## Context

Every systemd unit loaded the one production secrets file `/opt/semprec/shared/.env`, which held
every key of the deployment: the superuser `SEMPREC_MIGRATE_DATABASE_URL`, `CREDENTIALS_MASTER_KEY`
and every provider key. A compromise of any single process therefore yielded every secret,
including a connection that bypasses row-level security. The accepted decision
[[2026-09-24-immutable-releases-behind-an-atomic-current-symlink]] already states that the migrate
connection is one "no running service should hold", and
[[2026-09-10-ai-gateway-monopoly-on-provider-calls]] keeps provider credentials inside the gateway
— neither was enforced by how the secrets were distributed.

## Decision

Every key lives in exactly one group, a values-free template `deploy/shared/env/<group>.env.example`
installed as `/opt/semprec/shared/env/<group>.env` (`root:root 0600`, directory `0700`). A unit's
`EnvironmentFile=` lines are its allowlist: it loads the groups it needs and no others, with
`current/release.env` last on the long-running units. The migrate URL sits in its own group, which
no unit loads; only `deploy.sh` hands it to the transient migration and seed units.

`provision.sh` installs a missing group file from its template, or — when the legacy single file
exists — from the legacy file's last `KEY=` line per template key. It never overwrites an existing
group file, never modifies or deletes the legacy file, and never prints a value.

## Rejected alternatives

- **Per-service files with duplicated values.** Keys several services need (the gateway token, the
  role connection strings) would live in more than one file, and rotating one means editing every
  copy; the copies drift.
- **`provision.sh` rendering per-unit files from one master file.** The master file stays the
  place every secret is held together, a second source of truth is created, and the rendered files
  are stale until provisioning is rerun.

## Consequences

- A compromised service holds only its own groups: the transcribe worker has no master key and no
  provider key, and no running process holds the migrate URL.
- A new key picks exactly one group and is added to that group's template. On an existing host the
  template is not re-applied to an existing group file, so adding a key to an existing group is a
  manual edit followed by a restart of the units that load it.
- A key two units need is shared by placing it in a group both load, never by duplicating it.
- A host upgrading from the single file reruns `provision.sh`, verifies the group files and deletes
  the legacy file by hand; until then both exist and only the group files are read.
