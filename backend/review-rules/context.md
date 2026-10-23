This is the `backend/` platform of the Semprec monorepo (the other platforms,
`apple/` and `web/`, have their own review-rules and are reviewed
independently). Semprec is a personal life-organization system; the backend
is a TypeScript/Node pnpm workspace (`packages/*`, `services/*`)
implementing: a Postgres schema engine with a generic choke-point CRUD API,
Yjs CRDT blocks/canvas, ten hardcoded core databases, IMAP email sync, an
inbox processing pipeline, a module contract/registry, an AI agent runtime
(pi-agent-core) with MCP tools/approval queue/heartbeats, auth,
notifications, a REST API, WebSocket realtime, and a meeting-transcription
pipeline.

Work is tracked as a strictly sequential queue of GitHub issues, each fully
self-contained (context, requirements, explicit scope boundaries). A pull request is
expected to close exactly one such issue and implement only what it describes — see the
acceptance-criteria check, which verifies the diff against the linked issue directly.

The codebase is past scaffold: `packages/*` has a populated Postgres data layer
(schema, auth, mail sync, agent runs, blobs) behind the generic choke-point API,
`services/semprec-api` is a REST/WebSocket adapter onto it, `services/semprec-ai-gateway`
is the sole path to a model provider, `packages/realtime` carries authenticated
WebSocket sync and NOTIFY-driven invalidation, and `packages/queue` runs the
Graphile Worker-backed scheduler (heartbeats, mail sync sweeps, notification fanout,
trash purge, and more). Review-rules here apply in full to every PR touching this
tree, not just from some future first-real-implementation PR.

Tenancy: Semprec is multi-tenant. Each user has one tenant, which holds all of that
user's data and agents, and nothing is shared between tenants. Isolation is enforced
twice: by Postgres row-level security on every table classified
`semprec:tenancy=tenant`, and by an explicit tenant scope (`app.tenant_id`) on every
code path. A missing scope fails closed: nothing visible, writes refused. Until
go-live, `tenants_single_tenant_guard` keeps a deployment at one tenant, and the
transitional `app_tenant_default()` falls back to that sole tenant (`app_sole_tenant()`),
so the previous release keeps working. Code written before tenant scoping is moved onto
the scope by dedicated issues: do not report a pre-existing scope-less query that the
pull request neither adds nor changes. Earlier ADRs that rest on a single human account
(`docs/adr/2026-09-12-per-process-agent-run-watch-registry.md`,
`docs/adr/2026-09-12-thin-user-scoped-realtime-invalidations.md`) describe code that is
being replaced; they justify no new single-account code. Cross-tenant access is this
platform's most severe defect class; the rules are in `rules.md` and
`tasks/security.md`, and the decision is `docs/adr/2026-10-03-tenant-isolation-through-row-level-security.md`.

Actor type is the second authorization boundary, alongside tenant. `Actor.type` is
`'user' | 'ai_agent' | 'system'` (e.g. `createdBy` on a view,
`packages/data/src/chokePoint/authorization.ts`'s `assertViewWritable`), and it gates
what an AI agent may read, write, or adopt, per
`docs/adr/2026-09-10-single-writer-ownership-model.md` and
`docs/adr/2026-09-10-agent-writes-are-proposals-not-direct-writes.md`. A missing or
bypassable `actor.type === 'ai_agent'` check is the real privilege-escalation shape
to flag here.

This platform also reviews changes to its own `review-rules/` directory — the
rules, tasks, severities and scope enforced here — through
`tasks/review-rules.md`, which reports nothing for a pull request that does not
touch them.
