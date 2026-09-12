This is the `backend/` platform of the Semprec monorepo (the other platforms,
`apple/` and `web/`, have their own review-rules and are reviewed
independently). Semprec is a personal life-organization system; the backend
is a TypeScript/Node pnpm workspace (`packages/*`, `modules/*`, `services/*`)
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

Tenancy: `bootstrapFirstAccount` (`packages/data/src/auth/authActions.ts`) is the
only path to `createUser` outside tests, and it throws `NotFoundError` — before even
checking the provided token — as soon as `anyUserExists` is true, holding a Postgres
advisory lock across that check to close the race for concurrent callers. This
deployment can therefore never have more than one human account. Do not report
missing per-user authorization (a second human user reading or writing another
human user's data) as a finding — there is no second human user for one to read or
write. The authorization boundary that *is* real and load-bearing here is actor
type, not per-user ownership: `Actor.type` is `'user' | 'ai_agent' | 'system'`
(e.g. `createdBy` on a view, `packages/data/src/chokePoint/chokePoint.ts`'s
`assertViewWritable`), and it gates what an AI agent may read, write, or adopt, per
`docs/adr/2026-09-10-single-writer-ownership-model.md` and
`docs/adr/2026-09-10-agent-writes-are-proposals-not-direct-writes.md`. A missing or
bypassable `actor.type === 'ai_agent'` check is the real privilege-escalation shape
to flag here — a human-vs-human check is not.
