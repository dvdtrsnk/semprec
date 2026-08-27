Check for security vulnerabilities:

1. Hardcoded credentials, API keys, or tokens anywhere in the diff — critical.
2. SQL injection risk: string interpolation building a query instead of a
   parameterized query/query builder — critical.
3. Missing input validation at an API boundary (a route handler, a choke-point
   endpoint, a webhook receiver) that trusts external input without parsing/validating
   it first — high.
4. A secret, token, or credential value reaching a log call or an error response
   returned to a client — high.
5. An authorization check missing or weakened on an endpoint that previously required
   one (session/token check, ownership check on the resource being mutated) — critical.
6. A new external HTTP call (IMAP, AI gateway, webhook) with no timeout, no size cap
   on the response, or no error handling that could hang the owning process — medium.
7. An AI-provider credential (API key, token) configured or read anywhere outside
   `semprec-ai-gateway`'s own environment — high: only the gateway process may hold
   provider credentials, so a leak or misuse is containable to one process.
8. Any change under `.github/workflows/` that the linked issue's Task section does
   not explicitly call for — critical: the workflows ARE the merge gate, and a PR
   that weakens, bypasses, or fabricates a required check (e.g. no-oping the
   review bot, adding a self-passing check) is gate self-neutralization, not a
   normal code change.
