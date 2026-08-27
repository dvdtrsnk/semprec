Semprec is a monorepo for a personal life-organization system, split into three
top-level surfaces: `backend/` (a TypeScript/Node pnpm workspace — `packages/*`,
`modules/*`, `services/*`), `apple/` (a shared Swift codebase for the iOS and
macOS app), and `web/` (the web frontend). Today only `backend/` has real
content; `apple/` and `web/` are empty scaffolds waiting on their first issues.

The backend implements: a Postgres schema engine with a generic choke-point
CRUD API, Yjs CRDT blocks/canvas, ten hardcoded core databases, IMAP email
sync, an inbox processing pipeline, a module contract/registry, an AI agent
runtime (pi-agent-core) with MCP tools/approval queue/heartbeats, auth,
notifications, a REST API, WebSocket realtime, and a meeting-transcription
pipeline.

Work is tracked as a strictly sequential queue of GitHub issues, each fully
self-contained (context, requirements, explicit scope boundaries). A pull request is
expected to close exactly one such issue and implement only what it describes — see the
acceptance-criteria check, which verifies the diff against the linked issue directly.

The codebase is currently an early scaffold (empty package stubs); review-rules here
apply from the first real implementation PR onward.
