- All writes to item/database state go through the generic choke-point API
  (`POST`/`PATCH /api/items`, the relation endpoint, `confirm`/`revise`) — a new
  endpoint or process that mutates rows directly, bypassing it, is a high-severity
  finding.
 
- The backend assumes the first version: the schema is `0001_baseline.sql`, edited in
  place with the seed alongside. A second migration file, a backfill, a data cutover, a
  reconcile of already seeded tenants, or a compatibility shim or reader branch for data
  an older version wrote is medium (`docs/architecture/migrations-and-seeding.md`).
 
- No new abstraction, helper, or config flag beyond what the current issue's Task
  section asks for — speculative generality is a smell, not a virtue.
 
- Every LLM/AI-provider call goes through `semprec-ai-gateway` (which logs to
  `ai_gateway_calls` and enforces the daily/monthly budget caps). A direct provider
  SDK import or HTTP call to a model API from any other package or service is a
  critical finding — it bypasses both cost control and observability — unless the
  diff is inside the gateway itself.
 
- Only `semprec-transcribe` runs `ffmpeg`/`ffprobe`, and its production code spawns them
  only from `src/mediaNormalization.ts`. Spawning either binary anywhere else, or adding
  an npm package that bundles them, is a high-severity finding — it spreads a native host
  dependency and a parser of untrusted uploads to a process with neither the timeout nor
  the cleanup handling.
- AI/agent code never writes persisted state directly: agent-originated changes are
  proposals that go through the approval queue / `confirm` flow, where a human (or an
  explicit grant) authorizes the write. Agent code calling a write endpoint or the
  data layer directly is a high-severity finding.
 
- Canonical stored keys (`databases.key`, property keys, select-option values,
  settings keys) are English camelCase; view-type keys are English kebab-case
  (e.g. `mailbox-client`, `journal-inbox`). A Czech key introduced in code or a
  migration is a high-severity finding. User-facing label strings are never
  hardcoded — they resolve through the i18n layer (`cs.json`/`en.json` keyed by the
  English canonical key, selected by `users.locale`); a hardcoded user-facing label
  is medium.
- TypeScript: no `any` at a module boundary (external input, DB row, API payload) —
  parse/validate at the edge, trust internal types after that.
- Secrets, tokens, and credentials never appear in a log call, an error message
  returned to a client, or a committed file.
- A process that owns a piece of state (per the module contract / ownership model)
  is the only writer to it — a second writer appearing anywhere is a high-severity
  ownership violation, independent of whether the write itself looks correct.
 
- A change that contradicts a rule stated in `docs/architecture/` without updating that
  document in the same pull request is medium. A local pattern (one module, one
  operation, one lock order) needs no document; asking for an ADR or architecture
  entry for one is not a finding, and a new backend ADR file is itself medium.
- Comments describe current behavior and non-obvious reasons. An added comment that
  carries an issue number, changelog narration ("now", "previously", "after the
  cutover") or an ADR/architecture citation for ordinary code is medium; a docstring on
  a self-explanatory function is low. A missing docstring is not a finding.
- Validate at the boundary, trust inside: a guard or "cannot happen" throw for a state
  the types or schema already exclude is low (a simplification), never a request for a
  test.
- Tests cover behaviors and acceptance criteria. A new behavior or criterion with no test
  is medium; a branch without its own test, or a missing test for a defensive or
  unreachable branch, is not a finding. Permission checks are tested on both sides and
  tenant isolation through the shared harness on real Postgres; missing either is high.
- A targeted `DELETE`/`UPDATE` must check the rows it actually affected (`rowCount` or
  `RETURNING`) and act on it. Reporting a zero-row write as success is high: the client
  that trusted it will not retry.
- A pre-check that decides whether a write is allowed, or builds the "prior state" a
  response reports, is a guard only inside the write's own transaction. One run before
  `BEGIN` or on another connection is high: a concurrent request can change the row in
  the gap.
- A numeric request field is validated against the storing column's domain (integer
  width, sign, range), not just `typeof number`. A value Postgres rejects reaching the
  query is high: the caller gets a 500 instead of a 400 naming the field.
- A migration that creates a table states `COMMENT ON TABLE <t> IS 'semprec:tenancy=tenant'`
  or `'semprec:tenancy=global'` in the same file. A tenant table also gets, in that file,
  `tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id)`,
  `ENABLE ROW LEVEL SECURITY`, the RESTRICTIVE `tenant_isolation` policy
  (`USING`/`WITH CHECK (tenant_id = (SELECT app_tenant_default()))`) and the PERMISSIVE
  `tenant_rows` policy (`USING (true) WITH CHECK (true)`). Global is only for
  identity-plane, admin-plane and operator tables that hold no user content. Missing any
  of these is high: an unclassified or unprotected table is invisible to the mechanical
  isolation guarantee.
- A unique index, unique constraint or primary key on a tenant table that does not lead
  with `tenant_id` is high, unless it is a server-generated surrogate key or is scoped by
  the server-generated id of a parent row in the same tenant (such as
  `properties (database_id, key)`). Unique and foreign-key checks ignore RLS, so a global
  key is an existence oracle and a cross-tenant collision.
- Tenant identity taken from a request body, query string, path segment, a header an
  untrusted caller can set, a job payload field, or model output is critical: the caller
  chooses whose data it reaches. Its only sources are the authenticated session, the
  queue job envelope stamped from the producer's scope, a NOTIFY payload stamped by its
  publisher, an internal-token-authenticated caller cross-checked against a row visible
  in that tenant, an MCP run credential, and a router function resolving an external
  identifier (a Graph subscription id, a Gmail address) to its tenant.
- New code that reads or writes a tenant table must run in a scope established from one
  of those sources, or as explicit system work under the next rule. New code that relies
  on the transitional sole-tenant fallback as its tenant, or that picks "the" user or
  tenant by earliest, first or `LIMIT 1`, is high, because it silently breaks the day a
  second tenant exists; it is critical when it lets one tenant reach another's rows.
  Pre-existing scope-less code the pull request neither adds nor changes is not reported.
 
- Cross-tenant system work enumerates tenants and does each tenant's work inside that
  tenant, and one tenant's failure must not skip the others. The alternative is a
  `SECURITY DEFINER` function owned by a dedicated `NOLOGIN BYPASSRLS` router role:
  column-level `SELECT` only, pinned `search_path`, `EXECUTE` revoked from `PUBLIC` and
  granted to one runtime role, returning only ids or numbers. Any of the following is
  critical, because it removes the second enforcement layer: granting a runtime role
  `BYPASSRLS`, superuser or table ownership; `SET row_security = off`; a permissive
  policy that widens visibility; one query reading several tenants' rows.
- A `SECURITY DEFINER` function that reads or writes a tenant table without confining
  itself to `app_current_tenant()` (filtering by it, or verifying the referenced row's
  tenant) is critical: it runs with the owner's privileges and so bypasses RLS for any
  caller.
- An endpoint, socket frame, MCP tool or job must answer another tenant's id exactly as
  it answers a random id: same status, body and headers, and no branch such as an
  ETag/304 check taken before the tenant check. A difference is critical, because it
  tells the caller that the foreign row exists.
- The SQL-injection finding of `tasks/security.md` item 2 (critical) covers test code, DDL
  and trigger or function bodies. Where a statement cannot take parameters, quote inside
  Postgres (`format('%I')`, `format('%L')`) or pass the value through a table or setting.
  A provably closed value (a literal union, a generated UUID) with that invariant stated
  beside the interpolation is not that finding.
- A new unique index or unique constraint on a table that has `INSERT … ON CONFLICT`
  statements whose arbiter names a different index, left unchanged and not named as a
  follow-up in the pull request description, is high: a conflict on the new index raises
  `23505` past the arbiter and surfaces as a 500 under concurrent writes. When the
  statement's outcome also lets one tenant infer another's row (a surviving global unique
  index on a tenant table), it is critical under `tasks/security.md` item 9.
- A test that asserts tenant isolation through the superuser pool (`getTestPool()`), or
  with two users of one tenant instead of two tenants, is high: superusers and table owners
  bypass row-level security, so the test passes whether or not isolation holds.
- A log line or error message carrying user content (item properties, mail subjects,
  bodies or addresses, file names, prompts, model output) is high: logs are not
  tenant-scoped. Log ids and counts.
