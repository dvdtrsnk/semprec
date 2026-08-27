- All writes to item/database state go through the generic choke-point API
  (`POST`/`PATCH /api/items`, the relation endpoint, `confirm`/`revise`) — a new
  endpoint or process that mutates rows directly, bypassing it, is a high-severity
  finding — unless the issue itself is the one introducing that choke-point.
- Every migration is additive/backward-compatible; a column drop, type narrowing, or
  `NOT NULL` without a default on an existing table is critical unless the issue
  explicitly calls for it as a deliberate breaking change.
- No new abstraction, helper, or config flag beyond what the current issue's Zadani
  asks for — flag speculative generality the same way the project's own contribution
  guidance treats it: a smell, not a virtue.
- TypeScript: no `any` at a module boundary (external input, DB row, API payload) —
  parse/validate at the edge, trust internal types after that.
- Secrets, tokens, and credentials never appear in a log call, an error message
  returned to a client, or a committed file.
- A process that owns a piece of state (per the module contract / ownership model)
  is the only writer to it — a second writer appearing anywhere is a high-severity
  ownership violation, independent of whether the write itself looks correct.
