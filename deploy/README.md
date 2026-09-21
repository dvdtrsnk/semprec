# deploy/

Host-level operational configuration for the single-server production deployment (`operations`
batch). Provisioning (`provision.sh`, service units) is delivered by later issues in the same
batch. This directory holds the network boundary (#174), the bootstrap secrets contract (#175),
and host provisioning (#244, #176):

- `Caddyfile` — the single public entry point. One domain, automatic TLS, HSTS without
  `includeSubDomains`/`preload`, compression, JSON access log to stderr, and the two-tier
  `POST /api/files` request-body limit. Proxies everything to `semprec-api` on `127.0.0.1:8080`.
- `nftables.conf` — the host firewall: only 22/80/443 reachable from outside the host.
- `docker-compose.yml` — PostgreSQL and MinIO, both explicitly bound to `127.0.0.1`, both loading
  their init-time credentials from `/opt/semprec/shared/.env` via `env_file:`.
- `shared/.env.example` — the values-free template for `/opt/semprec/shared/.env`, the one
  production secrets file every service and both Docker Compose services read. See its header
  comment for the full contract (ownership/mode, distribution, backup exclusion). `provision.sh`
  (#244) copies this template into place only when no `.env` already exists there.
- `provision.sh` — idempotently installs the host packages/tree from #244 plus the systemd units,
  timer skeletons, shared timer scripts, and journald retention configuration from #176. Run it as
  root from this directory's checked-out copy. It never overwrites an existing shared `.env` or a
  release.
- `systemd/` — source units installed into `/etc/systemd/system`, a journald drop-in installed at
  `/etc/systemd/journald.conf.d/semprec.conf`, and timer-script skeletons installed under
  `/opt/semprec/shared/bin`. The timer bodies belong to #171, #177, and #178; their schedules are
  installed now so later provisioning updates replace only non-secret operational templates.

`semprec-api`, `semprec-agents`, `semprec-mailsync@`, `semprec-transcribe`, and
`semprec-ai-gateway` run as systemd units. The internal HTTP listeners bind to loopback in their
own `server.listen(port, "127.0.0.1", ...)` call, so that binding lives in
`backend/services/*/src/serve.ts`, not in a unit file. Each unit loads the same
`/opt/semprec/shared/.env` via `EnvironmentFile=` — the systemd half of the same distribution
contract `docker-compose.yml`'s `env_file:` already uses. A service that needs a value no other
process needs (e.g. `PORT`) still reads it out of this one file; nothing service-specific is ever
shipped inside a release directory, so a release contains no secret of any kind.

`semprec-agents` has no HTTP listener: it is the second graphile-worker composition root (issue
#91), owning the agent-affinity task catalog over the same Postgres-backed queue `semprec-api`
uses. Its unit is a long-running worker, not socket-activated.

## Logs and external liveness (issue #171)

Every Semprec systemd service supplies a distinct `SyslogIdentifier`; PostgreSQL and MinIO use
the Docker Compose `journald` driver with their own tags. This keeps process and container logs
filterable in one persistent journal. Provisioning configures `Storage=persistent`, a 2 GiB
maximum, and 90-day retention. Journal state is operational evidence, not backup input: #177's
restic job excludes `/var/log/journal` along with secrets and reproducible configuration.

The `semprec-dead-man` timer probes `https://$SEMPREC_DOMAIN/healthz` every five minutes before
pinging `HEALTHCHECKS_PING_URL`; failed health probes therefore never report a false success. The
four long-running services restart up to three times in five minutes. Only when that restart
limit is exhausted does systemd invoke `semprec-failping@%n.service`, which sends the failed unit
name to the monitor's `/fail` endpoint. A crash recovered by a restart does not trigger `/fail`.

## Encrypted off-site backups (issue #177)

`semprec-backup.timer` runs daily at 03:30. Its root-owned service first writes a PostgreSQL
custom-format dump to `/var/backups/semprec/postgres.dump`; only a completed dump is included in
the following restic snapshot. The same snapshot includes the Docker volume mounted at MinIO's
`/data`, discovered from the running MinIO container rather than assuming a Compose volume name.
The restic repository is S3-compatible and encrypted by restic. Only after `restic backup`
succeeds does the job run `restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune`.

The backup input inventory is intentionally narrow: the custom PostgreSQL dump and MinIO data
only. It excludes `/opt/semprec/shared/.env`, `apns-key.p8`, all credentials including
`CREDENTIALS_MASTER_KEY` (the deployment's secrets master key), `/var/log/journal`, certificates,
and reproducible release or deployment configuration. No restic invocation traverses a parent
directory that could include those paths. The daily schedule gives a maximum data-loss window
(RPO) of 24 hours, plus changes since the last completed daily backup.

No proxy-level auth, rate-limiting, IP filtering, or subdomains — all of that stays in the
application (`services/semprec-api`), by design.

## Bootstrap secrets (issue #175)

- **Two files, one contract.** `/opt/semprec/shared/.env` (this directory's `shared/.env.example`
  is its template) and `/opt/semprec/shared/apns-key.p8` (Apple's `.p8` APNs auth key — no
  template committed, since there is no values-free form of a private key; see the `.env.example`
  header for why it's a separate file instead of an inlined value). Both `root:root 0600`.
- **Distribution.** Every systemd unit (#176) loads `.env` via `EnvironmentFile=`; `apns-key.p8`
  is read directly by path (`APNS_PRIVATE_KEY_PATH`, `backend/packages/data/src/push/apnsAdapter.ts`).
  `docker-compose.yml`'s `postgres`/`minio` services load `.env` via `env_file:` (#174). No
  process ever receives a secret through a command-line argument, a file inside `releases/`, or a
  hardcoded default.
- **`external_credentials` stays separate.** A user's own IMAP/OAuth/MCP secrets
  (`packages/credentials`, `packages/data/src/credentials/externalCredentialsStore.ts`) are
  encrypted at rest under `CREDENTIALS_MASTER_KEY` (itself provisioned here) and live in their own
  table — this file never holds a per-user secret, only the deployment's own bootstrap secrets.
- **Nothing leaks sideways.** `deploy.sh` (#190) only ever writes `releases/`, never `shared/`, so
  redeploys and rollbacks can't touch these two files or copy their contents into a release.
  Neither file is ever logged (every reader treats its value as opaque, never echoes it — see
  `apnsAdapter.ts`'s and `packages/credentials/src/index.ts`'s own comments) and both are excluded
  from the restic backup (#177).
- **Idempotent preservation.** `provision.sh` (#244) places this template at `.env` only when no
  `.env` already exists there; `apns-key.p8` is never generated (Apple issues it, an operator
  uploads it manually) and provisioning never touches it once present. Rerunning provisioning
  never overwrites either an operator-configured `.env` value or an already-uploaded key.
