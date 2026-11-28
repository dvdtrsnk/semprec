This is the `backend/` platform of the Alldots monorepo (the other platforms,
`web/` and the three mobile platforms `mobile/`, `mobile/android/` and
`mobile/apple/`, have their own review-rules and are reviewed independently).
Alldots is a personal life-organization system; the backend
is a TypeScript/Node pnpm workspace (`packages/*`, `services/*`)
implementing: a Postgres schema engine with a generic choke-point CRUD API,
Yjs CRDT blocks/canvas, hardcoded core databases, IMAP email sync, an
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
`services/alldots-api` is a REST/WebSocket adapter onto it, `services/alldots-ai-gateway`
is the sole path to a model provider, `packages/realtime` carries authenticated
WebSocket sync and NOTIFY-driven invalidation, and `packages/queue` runs the
Graphile Worker-backed scheduler (heartbeats, mail sync sweeps, notification fanout,
trash purge, and more). Review-rules here apply in full to every PR touching this
tree, not just from some future first-real-implementation PR.

Tenancy: Alldots is multi-tenant. Each user has one tenant, which holds all of that
user's data and agents, and nothing is shared between tenants. Isolation is enforced
twice: by Postgres row-level security on every table classified
`alldots:tenancy=tenant`, and by an explicit tenant scope (`app.tenant_id`) on every
code path. A missing scope fails closed: nothing visible, writes refused.
`app_tenant_default()` is strict: it returns the tenant of the current scope and never
a sole-tenant fallback. Do not report a pre-existing scope-less query that the pull
request neither adds nor changes. Cross-tenant access is this platform's most severe
defect class; the rules are in `rules.md`, `tasks/security.md` and
`docs/architecture/tenancy-and-security.md`.

The architecture rules are in `docs/architecture/` (index `docs/architecture/README.md`),
current and normative; judge code against them, not against removed ADRs.

Actor type is the second authorization boundary, alongside tenant. `Actor.type` is
`'user' | 'ai_agent' | 'system'` (e.g. `createdBy` on a view,
`packages/data/src/chokePoint/authorization.ts`'s `assertViewWritable`), and it gates
what an AI agent may read, write, or adopt (`docs/architecture/agents-approvals-and-ai.md`).
A missing or
bypassable `actor.type === 'ai_agent'` check is the real privilege-escalation shape
to flag here.

This platform also reviews changes to its own `review-rules/` directory — the
rules, tasks, severities and scope enforced here — through
`tasks/review-rules.md`, which reports nothing for a pull request that does not
touch them.
