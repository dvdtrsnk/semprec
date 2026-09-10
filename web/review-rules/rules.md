- All writes to item/database state go through the backend's generic
  choke-point API — no direct database access from the web frontend.
  (`docs/adr/2026-09-10-choke-point-api-for-state-writes.md`)
- No new abstraction, helper, or config flag beyond what the current issue's
  Zadani asks for — flag speculative generality the same way the project's
  own contribution guidance treats it: a smell, not a virtue.
  (`docs/adr/2026-09-10-no-speculative-generality-beyond-issue-scope.md`)
- TypeScript: no `any` at a module boundary (API response, form input,
  route param) — parse/validate at the edge, trust internal types after
  that.
- Secrets, tokens, and credentials never appear in client-side code, a log
  call, or a committed file — anything sensitive stays server-side.
- User-supplied content rendered as HTML must be sanitized or use the
  framework's safe-by-default rendering — never raw string interpolation
  into the DOM.
- A PR that introduces a genuinely new architectural pattern not covered by an
  existing rule here or by an ADR must add one under `docs/adr/` (see
  `docs/adr/README.md` for the format) — a new cross-cutting pattern with no ADR
  and no rule covering it is a medium-severity finding.
