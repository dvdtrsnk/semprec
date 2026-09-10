# Semprec — how work is done here

Semprec is a personal life-organization system: a Postgres data layer behind a
generic choke-point API, Yjs CRDT blocks/canvas, an IMAP inbox pipeline, and an
agent runtime. `backend/` is a pnpm workspace (`packages/`, `modules/`,
`services/`), `web/` is React + TypeScript on Vite, `apple/` is one shared Swift
codebase for iOS and macOS (scaffold for now).

## The issue is the law

Work arrives as a fully self-contained GitHub issue. Implement exactly its
`## Task` — nothing from `### Out of scope`, even when it looks trivial or
you are already in the file. Its `## Acceptance criteria` is the list your
tests are written against. Speculative generality is treated as a defect here,
not a virtue (`docs/adr/2026-09-10-no-speculative-generality-beyond-issue-scope.md`).

If the Task genuinely requires an architectural pattern that no rule and no ADR
covers, add an ADR under `docs/adr/` in the same pull request — the format is in
`docs/adr/README.md`. Deciding it silently is the failure mode that rule exists
to prevent.

## Before you design anything

- **`docs/adr/`** — why the architecture is shaped the way it is. `ls docs/adr/`
  and grep the `area` frontmatter before introducing a pattern: a past decision
  may already cover it, for or against.
- **`review-rules/`** of every platform you touch (`backend/`, `web/`, `apple/`,
  and the repository root) — these are the rules the review bot enforces on your
  pull request, so reading them first is strictly cheaper than being told.
- **The skills below** — the same conventions in the form you need while writing.

## Skills — load the one matching what you are about to write

| Skill | Load it when |
|---|---|
| `implement-issue` | starting any issue — the execution contract |
| `state-writes` | anything that creates, updates or deletes persisted state |
| `db-migrations` | any schema change, constraint, index or backfill |
| `canonical-keys` | any stored key, option value, or user-facing label |
| `ai-gateway` | any LLM or AI-provider call |
| `io-hardening` | any new HTTP route, handler, or outbound call |
| `error-handling` | any `catch`, error mapping, or failure path |

## What this repository is strict about

1. Every write to item/database state goes through the generic choke-point API.
2. One owner, one writer — per the module contract's ownership model.
3. Migrations are additive and backward-compatible (expand/contract).
4. Every AI/provider call goes through `semprec-ai-gateway`.
5. Canonical stored keys are English camelCase (view types kebab-case); labels
   resolve through i18n and are never hardcoded.
6. Nothing crossing a boundary — a DB row, a JSONB column, an API payload, a
   model's tool-call arguments — stays `any` or an unchecked `as`. Type it or
   validate it at the edge, then trust it inside.
7. Agent-originated changes are proposals that go through approval/`confirm`,
   never direct writes.

## Tests

Three tiers, selected by filename, and a file belongs to exactly one:

- `*.unit.test.ts` — must not import anything that touches Postgres.
- `*.test.ts` — integration tier; runs against a real ephemeral Postgres that
  `globalSetup` provisions for the whole run.
- `*.e2e.test.ts` — end-to-end tier.

Write the test list from the issue's Acceptance criteria, plus every branch you
claim exists in a docstring, plus the failure paths (no user, provider refused,
endpoint absent) — those are where findings concentrate.

## Before you open a pull request

Run the same pipeline CI runs. A CI round-trip costs minutes; this costs seconds:

```
cd backend
pnpm run verify

cd ../web
pnpm run verify
```

Then read your own diff as a strict reviewer applying the `review-rules/` of
every platform you touched, and sweep it for debug prints, commented-out code
and files unrelated to this issue. Every claim you write in a docstring is a
claim the reviewer will check against the code — make it true or delete it.

## Review findings

The code-review bot blocks the merge at `medium` severity and above. Fix what it
gets right, and fix a cheap `low` finding when it is clearly correct. A finding
that is genuinely wrong gets a reasoned reply on its thread — not a code change
made to appease it. Changing correct code to silence a mistaken reviewer is how
a codebase acquires defects it will never explain.

## Language

Everything written into the repository or posted to GitHub is English: code,
comments, commit messages, pull request descriptions, issue comments. Only
direct conversation with the user follows the user's own language.
