- All writes to item/database state go through the backend's generic
  choke-point API — no direct database access from the web frontend
  (`docs/architecture/data-model-and-writes.md`).
- No new abstraction, helper, or config flag beyond what the current issue's
  Task asks for — flag speculative generality the same way the project's
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
- A genuinely new web-wide architectural pattern not covered by a rule here or a web
  ADR needs an ADR under `docs/adr/` in the same PR — medium if missing. A pattern
  local to one view or component needs none.
