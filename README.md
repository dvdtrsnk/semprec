# Semprec

Semprec is a personal life-organization system: a Postgres-backed data layer
with a generic API choke-point, Yjs CRDT blocks/canvas, an IMAP-driven inbox
pipeline, and an AI agent runtime (`pi-agent-core`) that acts through defined,
structured mechanisms instead of freeform notes. The goal is determinism
everywhere it matters — heartbeats bound to concrete events and databases,
schema changes only through code, agent actions inspectable and triggerable
via API/MCP rather than a silent background cron — as the explicit
alternative to the "tell the AI to do a lot and hope it works out" model of
tools like OpenClaw or Hermes.

This repo holds the implementation. The design and planning live separately,
in the `vize/` prototype of the `LifeOS` repo (local-only, no remote);
`backend.html` there is the full specification this implementation is built
from.

## Scope

Today this repo is backend-only: a pnpm workspace monorepo for the API,
agent runtime, sync services, and shared packages described below. It is
planned to grow into the monorepo for the whole product — including the iOS
app, macOS app, and web client — not just the backend.

## Where work comes from

This repo does **not** follow `backend.html` directly. Each unit of work has
its own fully self-contained GitHub Issue — context, task, and scope are
written directly in the issue, with no need to open the planning repo.
Issues are worked in order by number (`[N/21]` in the title), sequentially,
one at a time.

## Structure

- `packages/` — shared core: `data`, `module-registry`, `agent-runtime`,
  `queue`, `realtime`, `credentials`, `shared`.
- `modules/` — vertical slices (Emails, Semprec, later Books/Films) — created
  incrementally as the issue queue progresses.
- `services/` — standalone processes (`semprec-api`, `semprec-agents`,
  `semprec-mailsync`, `semprec-transcribe`, `semprec-ai-gateway`) — created
  incrementally as the issue queue progresses.

## Stack

Node LTS, TypeScript, pnpm workspace, Postgres (+ Prisma), `graphile-worker`.

## Branching and releases

`develop` is the integration branch — all feature/issue work targets it via
PR, gated by an automated code review. `main` holds released versions only:
it advances exclusively through a `develop -> main` promotion PR, which on
merge triggers a release pipeline that tags and publishes a GitHub Release
from the version in `package.json`.
