# deploy/

Host-level operational configuration for the single-server production deployment (issue #174 of
the `operations` batch — see `docs/adr/README.md` for how this batch's issues fit together).
Provisioning (`provision.sh`, service units, secrets) is delivered by later issues in the same
batch (#175, #176, #244); this directory currently holds only the network boundary:

- `Caddyfile` — the single public entry point. One domain, automatic TLS, HSTS without
  `includeSubDomains`/`preload`, compression, JSON access log to stderr, and the two-tier
  `POST /api/files` request-body limit. Proxies everything to `semprec-api` on `127.0.0.1:8080`.
- `nftables.conf` — the host firewall: only 22/80/443 reachable from outside the host.
- `docker-compose.yml` — PostgreSQL and MinIO, both explicitly bound to `127.0.0.1`.

`semprec-api` and `semprec-ai-gateway` aren't containerized — they run as systemd units (#176)
and bind to loopback in their own `server.listen(port, "127.0.0.1", ...)` call, so that binding
lives in `backend/services/*/src/serve.ts`, not here.

No proxy-level auth, rate-limiting, IP filtering, or subdomains — all of that stays in the
application (`services/semprec-api`), by design.
