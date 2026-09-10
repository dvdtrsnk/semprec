- All writes to item/database state go through the generic choke-point API
  (`POST`/`PATCH /api/items`, the relation endpoint, `confirm`/`revise`) — a new
  endpoint or process that mutates rows directly, bypassing it, is a high-severity
  finding — unless the issue itself is the one introducing that choke-point.
  (`docs/adr/2026-09-10-choke-point-api-for-state-writes.md`)
- Every migration is additive/backward-compatible; a column drop, type narrowing, or
  `NOT NULL` without a default on an existing table is critical unless the issue
  explicitly calls for it as a deliberate breaking change.
  (`docs/adr/2026-09-10-expand-contract-forward-only-migrations.md`)
- No new abstraction, helper, or config flag beyond what the current issue's Task
  section asks for — flag speculative generality the same way the project's own
  contribution guidance treats it: a smell, not a virtue.
  (`docs/adr/2026-09-10-no-speculative-generality-beyond-issue-scope.md`)
- Every LLM/AI-provider call goes through `semprec-ai-gateway` (which logs to
  `ai_gateway_calls` and enforces the daily/monthly budget caps). A direct provider
  SDK import or HTTP call to a model API from any other package or service is a
  critical finding — it bypasses both cost control and observability — unless the
  diff is inside the gateway itself.
  (`docs/adr/2026-09-10-ai-gateway-monopoly-on-provider-calls.md`)
- AI/agent code never writes persisted state directly: agent-originated changes are
  proposals that go through the approval queue / `confirm` flow, where a human (or an
  explicit grant) authorizes the write. Agent code calling a write endpoint or the
  data layer directly is a high-severity finding.
  (`docs/adr/2026-09-10-agent-writes-are-proposals-not-direct-writes.md`)
- Canonical stored keys (`databases.key`, property keys, select-option values,
  settings keys) are English camelCase; view-type keys are English kebab-case
  (e.g. `mailbox-client`, `journal-inbox`). A Czech key introduced in code or a
  migration is a high-severity finding. User-facing label strings are never
  hardcoded — they resolve through the i18n layer (`cs.json`/`en.json` keyed by the
  English canonical key, selected by `users.locale`); a hardcoded user-facing label
  is medium. (`docs/adr/2026-09-10-english-canonical-keys-with-i18n-labels.md`)
- TypeScript: no `any` at a module boundary (external input, DB row, API payload) —
  parse/validate at the edge, trust internal types after that.
- Secrets, tokens, and credentials never appear in a log call, an error message
  returned to a client, or a committed file.
- A process that owns a piece of state (per the module contract / ownership model)
  is the only writer to it — a second writer appearing anywhere is a high-severity
  ownership violation, independent of whether the write itself looks correct.
  (`docs/adr/2026-09-10-single-writer-ownership-model.md`)
- A PR that introduces a genuinely new architectural pattern not covered by an
  existing rule here or by an ADR must add one under `docs/adr/` (see
  `docs/adr/README.md` for the format) — a new cross-cutting pattern with no ADR
  and no rule covering it is a medium-severity finding.
