# deploy/

Host-level operational configuration for the single-server production deployment (`operations`
batch). Provisioning (`provision.sh`, service units) is delivered by later issues in the same
batch. This directory holds the network boundary (#174), the bootstrap secrets contract (#175),
and host provisioning (#244, #176):

- `Caddyfile` — the single public entry point. One domain, automatic TLS, HSTS without
  `includeSubDomains`/`preload`, compression, JSON access log to stderr, and the two-tier
  `POST /api/files` request-body limit. Reverse-proxies `/api/*`, `/mcp` and `/healthz` to
  `semprec-api` on `127.0.0.1:8080` and serves the web client from
  `/opt/semprec/current/web/dist` with an `index.html` fallback. Installed to
  `/etc/caddy/Caddyfile` by `provision.sh`, which also enables `caddy.service` and hands it
  `SEMPREC_DOMAIN` through `/etc/caddy/semprec.env`.
- `nftables.conf` — the host firewall: only 22/80/443 reachable from outside the host. Installed
  to `/etc/nftables.conf` and enabled by `provision.sh`, which also reloads `nftables.service`. It
  owns only its own `table inet semprec` and never flushes the ruleset, so Docker's own `ip
  filter`/`ip nat` tables are left alone.
- `docker-compose.yml` — PostgreSQL only, bound to `127.0.0.1`. Its container receives exactly
  `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB`, interpolated from
  `/opt/semprec/shared/env/postgres.env` by `docker compose --env-file
  /opt/semprec/shared/env/postgres.env -f deploy/docker-compose.yml up -d` — no other variable in that file reaches the container. A host
  provisioned before this file dropped MinIO can remove its now-unused volume by hand (check its
  name with `docker volume ls`, typically `<project>_minio_data`) with `docker volume rm
  <volume-name>` — optional, not scripted.
- `shared/env/<group>.env.example` — twelve values-free templates, one per secret group
  (`postgres`, `migrate`, `data-role`, `side-role`, `master-key`, `gateway-token`, `ai-gateway`,
  `api`, `agents`, `settings`, `backup`, `monitor`), for `/opt/semprec/shared/env/<group>.env`. Each
  key is in exactly one group and each template's header names the units that load it
  (`docs/adr/2026-10-03-per-service-secret-groups.md`). `provision.sh` installs a template only
  when its group file does not exist yet.
- `provision.sh` — idempotently installs the host packages/tree from #244 plus the systemd units,
  timer skeletons, shared timer scripts, and journald retention configuration from #176. Run it as
  root from this directory's checked-out copy. It never overwrites an existing group file or a
  release.
- `systemd/` — source units installed into `/etc/systemd/system`, a journald drop-in installed at
  `/etc/systemd/journald.conf.d/semprec.conf`, and timer-script skeletons installed under
  `/opt/semprec/shared/bin`. The timer bodies belong to #171, #177, and #178; their schedules are
  installed now so later provisioning updates replace only non-secret operational templates.

`semprec-api`, `semprec-agents`, `semprec-transcribe`, and `semprec-ai-gateway` run as systemd
units; mail live-sync runs inside `semprec-api`, not as a unit of its own. The internal HTTP listeners bind to loopback in their
own `server.listen(port, "127.0.0.1", ...)` call, so that binding lives in
`backend/services/*/src/serve.ts`, not in a unit file. Each unit's
`EnvironmentFile=` lines are its allowlist of secret groups; nothing service-specific is ever
shipped inside a release directory, so a release contains no secret of any kind:

| unit | groups (in `/opt/semprec/shared/env/`) |
|---|---|
| `semprec-api` | `data-role`, `master-key`, `gateway-token`, `api`, `settings` |
| `semprec-agents` | `data-role`, `master-key`, `gateway-token`, `agents`, `settings` |
| `semprec-transcribe` | `data-role`, `gateway-token`, `settings` |
| `semprec-ai-gateway` | `side-role`, `gateway-token`, `ai-gateway` |
| `semprec-backup` | `postgres`, `settings`, `backup` |
| `semprec-restore-test` | `side-role`, `settings`, `backup` |
| `semprec-dead-man`, `semprec-failping@` | `monitor` |
| `semprec-trash-purge` | none |

The four long-running units load `current/release.env` last. `migrate` is loaded by no unit: only
`deploy.sh` hands it to its transient migration and seed units.

`semprec-agents` has no HTTP listener: it is the second graphile-worker composition root (issue
#91), owning the agent-affinity task catalog over the same Postgres-backed queue `semprec-api`
uses. Its unit is a long-running worker, not socket-activated.

## Deploying a release (issue #190)

`deploy.sh <tag>` deploys one release tag (`docs/operations/releases.md`) as an immutable
directory behind the atomic `current` symlink
([ADR](../docs/adr/2026-09-24-immutable-releases-behind-an-atomic-current-symlink.md)). Run it as
root from an operator checkout of this repository whose `origin` holds the tags:

```sh
sudo deploy/deploy.sh v1.2.3
```

In order, it:

1. refuses a tag that is not `vMAJOR.MINOR.PATCH`, is not an annotated tag on `origin`, does not
   point at a commit on `main`, or already has a `releases/<tag>` directory;
2. exports the tagged commit into a hidden `releases/.<tag>.partial.*` directory, runs
   `pnpm install --frozen-lockfile` and `pnpm -r run build` in its `backend/` and
   `pnpm install --frozen-lockfile` + `pnpm run build` in its `web/`, producing `web/dist`, and
   writes `release.env` (`APP_VERSION=<tag>`, not a secret);
3. runs the release's migrations CLI in a transient `systemd-run` unit that loads
   `/opt/semprec/shared/env/migrate.env` — and nothing else — and connects with its
   `SEMPREC_MIGRATE_DATABASE_URL`, then runs the
   seed CLI (`runSeedCli.js`) right after it the same way, under the same URL — it creates the
   system databases on a fresh install and is a no-op once they exist (see
   [`docs/operations/seeding.md`](../docs/operations/seeding.md));
4. renames the staging directory to `releases/<tag>`, then replaces `current` with one
   `rename(2)`;
5. restarts `semprec-ai-gateway`, `semprec-api` (which also hosts mail live-sync),
   `semprec-agents` and `semprec-transcribe`, and prints the `APP_VERSION` each running process has.

A failure in steps 1–3 removes the staging directory and exits non-zero with `current` and every
service untouched. A failure in step 5 exits non-zero too, but `current` already names the new
release. Only one deploy runs at a time (`/opt/semprec/.deploy.lock`).

Every long-running unit loads `current/release.env` after its group files, so the version a
process reports comes from the release it runs. The script never reads, copies or prints
`migrate.env`; a release directory contains no secret. `deploy.sh` stops with "run provision.sh
first" when `migrate.env` is missing, so a host still on the legacy single file needs `provision.sh`
rerun first (see "Bootstrap secrets"). `deploy.test.sh` is the hermetic behavior test.

## Rolling back (issue #191)

`deploy.sh --rollback <tag>` moves `current` back to the release before the newest one
([ADR](../docs/adr/2026-09-24-rollback-one-release-back-with-checked-migrations.md)):

```sh
sudo deploy/deploy.sh --rollback v1.2.2
```

It builds nothing, fetches nothing and runs no migration — the schema stays as the newest release
left it, which [the migration rules](../docs/operations/migrations.md) keep compatible with the
code one release back. It refuses, before changing anything, unless:

- `releases/<tag>` is a complete release directory whose `release.env` declares
  `APP_VERSION=<tag>`;
- `<tag>` is the release directly before the newest release on disk;
- `current` still points at that newest release (so a second rollback in a row is refused).

Then it swaps `current` with the same `rename(2)`, restarts the same services, and fails unless
every process reports `<tag>`. It takes the same lock as a deploy. The way forward from a rollback
is a new, fixed release deployed normally. `deploy.test.sh` covers rollback too.

## Logs and external liveness (issue #171)

Every Semprec systemd service supplies a distinct `SyslogIdentifier`; PostgreSQL uses
the Docker Compose `journald` driver with its own tag. This keeps process and container logs
filterable in one persistent journal. Provisioning configures `Storage=persistent`, a 2 GiB
maximum, and 90-day retention. Journal state is operational evidence, not backup input: #177's
restic job excludes `/var/log/journal` along with secrets and reproducible configuration.

The `semprec-dead-man` timer probes `https://$SEMPREC_DOMAIN/healthz` every five minutes before
pinging `HEALTHCHECKS_PING_URL`; failed health probes therefore never report a false success. The
four long-running services restart every 5 seconds for up to 15 minutes (180 attempts). Only when
that restart limit is exhausted does systemd invoke `semprec-failping@%n.service`, which sends the
failed unit name to the monitor's `/fail` endpoint. A crash recovered by a restart does not trigger
`/fail`.

## Encrypted off-site backups (issue #177)

`semprec-backup.timer` runs daily at 03:30. Its root-owned service first writes a PostgreSQL
custom-format dump to `/var/backups/semprec/postgres.dump`; only a completed dump is included in
the following restic snapshot. The same snapshot includes the two blob storage directories the
`blobs` rows point into, `FILES_STORAGE_DIR` (`/opt/semprec/data/files`) and
`MAIL_ATTACHMENTS_DIR` (`/opt/semprec/data/mail-attachments`); a missing directory fails the
backup before restic runs. MinIO is not used by the application and is not backed up. The
restic repository is S3-compatible and encrypted by restic. Only after `restic backup` succeeds
does the job run `restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune`.

The backup input inventory is intentionally narrow: the custom PostgreSQL dump and the two blob
storage directories only. It excludes `/opt/semprec/shared/env/`, the legacy `/opt/semprec/shared/.env`, `apns-key.p8`, all credentials
including `CREDENTIALS_MASTER_KEY` (the deployment's secrets master key), `/var/log/journal`,
certificates, and reproducible release or deployment configuration. No restic invocation traverses a parent
directory that could include those paths. The daily schedule gives a maximum data-loss window
(RPO) of 24 hours, plus changes since the last completed daily backup.

No proxy-level auth, rate-limiting, IP filtering, or subdomains — all of that stays in the
application (`services/semprec-api`), by design.

## Monthly restore test (issue #178)

`semprec-restore-test.timer` runs monthly. Its root-owned service restores the newest restic
snapshot into a temporary directory under `/var/tmp`, then starts a disposable PostgreSQL
container on a new `--internal` Docker network. It never addresses the production Compose
containers or volumes. The run passes only if all of these hold:

- `pg_restore --exit-on-error` of the restored custom dump succeeds;
- `items` is non-empty and its newest `updated_at` is at most 48 hours old;
- `doc_snapshots` is non-empty and no row has an empty `state`;
- 20 random hashed `blobs` rows (all of them, when fewer exist) each have a restored file with
  exactly the recorded size and SHA-256 hash — looked up by `storage_key` under the restored
  `FILES_STORAGE_DIR` first, then under the restored `MAIL_ATTACHMENTS_DIR`.

The container, the network, and the restored files are removed on every exit path; a cleanup
that cannot finish fails the run. Only then does a passing run mark the `backup:restoreTest`
observability check `ok` and ping `HEALTHCHECKS_RESTORE_PING_URL`. A failed run marks that check
`alerting`, writes one `backup_restore_failed` notification through the data layer's
`writeNotification` (the `restoreTestResultCli.js` of the current release, as `semprec_side`),
pings the monitor's `/fail` endpoint, and exits non-zero. It never sends the success ping.
`deploy/systemd/scripts/semprec-restore-test.test.sh` is the hermetic behavior test.

## Bootstrap secrets (issue #175)

- **Twelve group files plus the key file.** `/opt/semprec/shared/env/<group>.env` (the templates
  are `shared/env/<group>.env.example`) and `/opt/semprec/shared/apns-key.p8` (Apple's `.p8` APNs
  auth key — no template committed, since there is no values-free form of a private key; see
  `shared/env/api.env.example` for why it's a separate file instead of an inlined value). `shared/env`
  is `root:root 0700` and each group file `root:root 0600`, since systemd reads `EnvironmentFile=` as
  root before dropping privileges; `apns-key.p8` is `root:semprec 0640` inside `/opt/semprec/shared`
  (itself `root:semprec 0750`), since the `semprec` service user reads the key directly by path.
  `provision.sh` corrects all of these ownerships and modes on every run.
- **Distribution.** A unit loads only the groups listed for it in the table above (#176);
  `apns-key.p8` is read directly by path (`APNS_PRIVATE_KEY_PATH`,
  `backend/packages/data/src/push/apnsAdapter.ts`). `docker-compose.yml`'s `postgres` service
  (#174) receives three values of `postgres.env` — `POSTGRES_USER`, `POSTGRES_PASSWORD`,
  `POSTGRES_DB` — interpolated by `docker compose --env-file`, never the file itself. No process
  ever receives a secret through a command-line argument, a file inside `releases/`, or a
  hardcoded default.
- **`external_credentials` stays separate.** A user's own IMAP/OAuth/MCP secrets
  (`packages/credentials`, `packages/data/src/credentials/externalCredentialsStore.ts`) are
  encrypted at rest under `CREDENTIALS_MASTER_KEY` (provisioned in `master-key.env`) and live in
  their own table — these files never hold a per-user secret, only the deployment's own bootstrap
  secrets.
- **Nothing leaks sideways.** `deploy.sh` (#190) only ever writes `releases/`, never `shared/`, so
  redeploys and rollbacks can't touch these files or copy their contents into a release. No file is
  ever logged (every reader treats its value as opaque, never echoes it — see `apnsAdapter.ts`'s
  and `packages/credentials/src/index.ts`'s own comments) and all are excluded from the restic
  backup (#177).
- **Idempotent preservation.** `provision.sh` (#244) installs a template as `<group>.env` only when
  that file does not exist; it never overwrites an existing group file, so an operator's values
  survive every rerun, and a deleted group file is re-created from its template. `apns-key.p8` is
  never generated (Apple issues it, an operator uploads it manually) and provisioning never
  touches it once present.
- **Adding a key.** A new key picks exactly one group and is added to that group's template. On an
  existing host the template is not re-applied to an existing group file, so the line is added to
  `/opt/semprec/shared/env/<group>.env` by hand, followed by a restart of the units that load it.
- **Upgrading from the single `.env`.** Rerun `provision.sh`. For every group file that does not
  exist yet it takes each template line `KEY=…` and replaces it with the legacy
  `/opt/semprec/shared/.env`'s last `KEY=` line, verbatim; keys no group claims are not copied, and
  their names (never their values) are printed to stderr together with a note that the legacy file
  is no longer read. It never modifies or deletes the legacy file. Verify the group files, restart
  the units (`systemctl restart semprec-api semprec-agents semprec-transcribe semprec-ai-gateway`),
  and only then delete `/opt/semprec/shared/.env` by hand.

## Czech full-text search (issues #206, #207)

`provision.sh` copies the `hunspell-cs` dictionary and affix files into the PostgreSQL container's
`tsearch_data` directory as `cs_cz.dict` and `cs_cz.affix` (PostgreSQL rejects uppercase
dictionary basenames). Backend migration `0046_czech_hunspell_search.sql` then switches the
`czech` text search configuration to lemmatize words through that dictionary ahead of the
`unaccent`/`simple` fallback. Without the files, the migration still succeeds and search keeps the
fallback.

The switch is re-attempted by the migrations CLI on every deploy and is a no-op once active, so a
database migrated before the files were installed is upgraded by the first deploy after
provisioning. Messages indexed before that keep their fallback lexemes until they are reindexed.

The files live in the container's filesystem, not in a volume. Once the dictionary is active,
PostgreSQL needs them to index or search any message, so rerun `provision.sh` whenever the
`postgres` container is recreated.

## Front door (Caddy)

`provision.sh` installs `Caddyfile` to `/etc/caddy/Caddyfile` and a systemd drop-in
(`systemd/caddy-semprec.conf`) to `/etc/systemd/system/caddy.service.d/semprec.conf` that points
`caddy.service` at an `EnvironmentFile=/etc/caddy/semprec.env`. It then reads `SEMPREC_DOMAIN` out
of `/opt/semprec/shared/env/monitor.env` and renders that one value into `/etc/caddy/semprec.env`
(`root:root 0600`) — Caddy never reads the group file itself, only the one value it needs.

On a first run against a freshly installed `monitor.env` template, `SEMPREC_DOMAIN` is still empty:
provisioning prints a warning to stderr and leaves Caddy unconfigured rather than failing, so the
rest of provisioning still completes. Once an operator sets `SEMPREC_DOMAIN` and reruns
`provision.sh`, it writes `/etc/caddy/semprec.env`, enables and (re)loads `caddy.service`, and
validates the rendered config. Rerunning with an unchanged domain is a no-op on the rendered file.

`PORT=8080` must also be set in `api.env` — `Caddyfile`'s `reverse_proxy` targets
`127.0.0.1:8080` and `semprec-api` listens on `PORT`, so the two values have to agree.

`APP_BASE_URL` in `api.env` must equal `https://$SEMPREC_DOMAIN`: it is the origin every
emailed link is built against, and semprec-api falls back to `http://localhost:3000` without it.
Without both `SMTP_HOST` and `SMTP_FROM_ADDRESS` no password-reset mail is sent, although the
request still answers `200`. `provision.sh` warns about both on every run without failing or editing
the file. A host whose `api.env` predates these keys needs the seven lines (`APP_BASE_URL`,
`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM_ADDRESS`, `SMTP_USER`, `SMTP_PASSWORD`) from
`shared/env/api.env.example` added to it by hand, then `systemctl restart semprec-api`.

## Web client

`deploy.sh` builds `web/` (`pnpm install --frozen-lockfile` and `pnpm run build`) into the staged
release alongside `backend/`, producing `web/dist`. `Caddyfile` serves that directory straight off
the `current` symlink, so a deploy or rollback switches the web client and the backend together —
there is no separate release or version for the client. The prefixes `Caddyfile` reverse-proxies to
`semprec-api` (`/api/*`, `/mcp`, `/healthz`) must stay in step with the ones `web/vite.config.ts`
proxies in development.

## Host firewall (nftables)

`provision.sh` installs `nftables.conf` to `/etc/nftables.conf`, enables `nftables.service`, and
reloads it. The ruleset owns only its own `table inet semprec` and never flushes the ruleset, so
Docker's own `ip filter`/`ip nat` tables — and the port mappings and masquerading they provide —
are left alone. Container-to-container traffic is governed entirely by Docker's own chains; this
ruleset has no `forward` chain of its own.
