- All writes to item/database state go through the backend's generic
  choke-point API — no direct database access from the web frontend.
- No new abstraction, helper, or config flag beyond what the current issue's
  Zadani asks for — flag speculative generality the same way the project's
  own contribution guidance treats it: a smell, not a virtue.
- TypeScript: no `any` at a module boundary (API response, form input,
  route param) — parse/validate at the edge, trust internal types after
  that.
- Secrets, tokens, and credentials never appear in client-side code, a log
  call, or a committed file — anything sensitive stays server-side.
- User-supplied content rendered as HTML must be sanitized or use the
  framework's safe-by-default rendering — never raw string interpolation
  into the DOM.
