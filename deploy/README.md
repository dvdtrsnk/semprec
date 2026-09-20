# deploy/

Host-level operational configuration for the single-server production deployment (`operations`
batch). This directory holds the network boundary (#174), the bootstrap secrets contract (#175),
and the first provisioning slice (#244):

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
- `provision.sh` — idempotently prepares a supported Debian or Ubuntu host: Node 22 LTS with
  pnpm, Docker Compose, Caddy, restic, ffmpeg/ffprobe, the `semprec` service user, and the
  `/opt/semprec/{releases,shared}` tree. Run it as root from this directory's checked-out copy.
  Existing release contents and `/opt/semprec/shared/.env` are deliberately left untouched.

`semprec-api`, `semprec-ai-gateway`, and `semprec-agents` aren't containerized — they run as
systemd units (#176). `semprec-api` and `semprec-ai-gateway` bind to loopback in their own
`server.listen(port, "127.0.0.1", ...)` call, so that binding lives in
`backend/services/*/src/serve.ts`, not here; `semprec-agents` has no HTTP listener at all — it is
the second graphile-worker composition root (issue #91), owning the closed agent task catalog
(`heartbeatFireAgent`/`agentRun`/`delegatedAgentRun`) over the same Postgres-backed queue
`semprec-api` uses, and needs its own long-running unit with no `Type=notify`/socket activation.
Each unit loads the same
`/opt/semprec/shared/.env` via `EnvironmentFile=` — the systemd half of the same distribution
contract `docker-compose.yml`'s `env_file:` already uses. A service that needs a value no other
process needs (e.g. `PORT`) still reads it out of this one file; nothing service-specific is ever
shipped inside a release directory, so a release contains no secret of any kind.

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
