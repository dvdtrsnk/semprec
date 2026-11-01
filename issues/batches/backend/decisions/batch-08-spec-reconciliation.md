# Batch 08 specification reconciliation

Authority: owner-delegated parent controller `thr_pz39tcih5r`, under
`2026-10-31-owner-delegated-backend-program-supervision`. This approves an exact
requirement correction before acceptance; it records no successful test result
and completes no issue. Original implementation handovers remain unchanged.

## Generic localized problem notification titles

Gh-1466 Task 4 requested a title parameter for a problem title. The current
`RaiseProblemInput` and `semp_problems` table have no title field. Gh-1459
separately assigns problem text rendering to a later read model. The actual
notification catalogs already define a generic `notification.semp_problem.title`
for both supported locales, without a placeholder; `writeNotification` resolves
that entry using the receiving user's locale. Its interpolation support alone
does not provide a truthful problem title. The original gh-1466 handover admits
the omitted parameter and is provenance, not compliance evidence.

Use the generic localized entry for this batch, with no problem-specific title
parameter. Do not invent a title from internal kind keys, source identifiers or
provider/error text, and do not add a title field or alter producer inputs.
Problem-specific push titles would require a separately specified source,
ownership, localization and content contract; this decision grants none.
The detailed read model remains outside this change.

Correct gh-1466 Context, Tasks 4 and 5, scope and acceptance criteria, propagate
its complete embedded snapshot and specification hashes to batch 08, and
reapprove those exact records under the existing delegation. Keep severity,
transition identity, notification deduplication, user preferences, delivery and
suppression of source-kind pushes unchanged. No historical accepted ADR is
edited, no new persistence or lifecycle mechanism is introduced, and no other
member requirement is waived.

Acceptance requires actual production `raiseProblem` and fan-out evidence for
both `cs` and `en`: the stored notification title and outbound push title equal
the respective generic catalog entry, without unresolved placeholders or
internal/provider content substituted into that title. Use the existing scoped
`sempProblemNotification.test.ts` production-path fixture and owned fake senders;
no live provider call or client work is needed. Existing tests and source
inspection alone have not yet established these acceptance results.

## Recovered MCP grants integration test path

Gh-1455 Touches names a new
`backend/packages/data/src/mcp/__tests__/mcpAgentPageGrants.test.ts`.
The recovered permanent suite instead exists at
`backend/packages/data/src/__tests__/mcpAgentPageGrants.test.ts`; the named
`mcp/__tests__` file does not exist. Inspection confirms the existing suite
calls the production grants listing and counting function and contains the
five-registration, inactive-server and failed-then-successful connection cases.
The original gh-1455 handover also records this placement.

Use the existing suite for the required permanent assertions. Correct only the
source Touches path and its embedded and aggregate Touches entries, regenerate
the affected specification hashes and reapprove those exact records. Do not
move or duplicate the suite. All Tasks, acceptance criteria and required HTTP
handler tests remain unchanged. This authorizes test maintenance at the actual
path; neither its presence nor this inspection establishes a passing test or
complete acceptance evidence.

## Real MCP invocation connection-state evidence

Gh-1450's scoped unit suite mocks connection creation and the state store; its
store integration suite separately proves database behavior. The existing
`backend/packages/data/src/__tests__/mcpConnectionFactory.test.ts` already calls
real `executeMcpInvocation`, owns local stdio/SSE/HTTP contract servers and uses
runtime-role tenant fixtures. Reuse that harness for composed evidence rather
than duplicating transport setup in a parallel test suite.

Add exactly that integration test path to gh-1450 and batch 08 Touches. Permit
focused permanent tests of the real invocation-to-connection-state path using
runtime roles and explicit tenant scopes. Verify the requested connection
success/failure transitions and that a tool-call failure after a successful
connection still records connection success. Preserve the existing independent
rollback and recording-failure evidence; a test-specific setup must exercise
its stated production boundary rather than pass through a different guard.

This adds a test path, not a transport or persistence contract. Do not alter
stdio environment inheritance, its allowlist, contract assertions or the known
inherited-name test to obtain a passing pipeline. Preserve the previously
accepted transport classification and safe logging behavior. No live provider
probe, new connection mechanism or package dependency is authorized. Existing
Task/AC obligations remain unchanged; no test result or exception is granted.

## Same-severity notification deduplication preserves problem bookkeeping

Gh-1466's Context, Task 6 and third acceptance criterion say a repeated raise
writes nothing. Read literally across all state, that contradicts gh-1459's
existing occurrence-count and last-seen bookkeeping for a distinct occurrence,
and gh-1466's own requirement to store source notifications while suppressing
their pushes. The current writer performs that bookkeeping and writes a
`semp_problem` notification only for creation or severity escalation.

Clarify the three gh-1466 clauses: a repeated same-severity raise creates no
new `semp_problem` notification or additional push. Preserve distinct-occurrence
bookkeeping and producer-owned source notifications. An identical
`occurrenceKey` keeps gh-1459's existing replay semantics; this is not a claim
that no SQL statement executes or that every stored column remains unchanged.
Do not suppress occurrence counting or source notifications to satisfy the old
ambiguous wording. Existing escalation and preference behavior remains intact.
The original handover is unchanged; the corrected source and aggregate are
reapproved with regenerated hashes. No production behavior change is authorized
by this wording correction.

## Populated upgrades for the five batch migrations

Add the existing permanent integration suite
`backend/packages/data/src/__tests__/migrationCompatibility.test.ts` to the
Touches of gh-1391, gh-1463, gh-1450, gh-1441 and gh-1466 and their batch
aggregate. Its current real-runner scratch-database fixture is an appropriate
place for the required populated historical upgrade evidence for migrations
0093, 0098, 0099, 0119 and 0121. Reuse that setup instead of treating an
already-migrated integration database as upgrade evidence.

Establish populated state before the relevant migration, apply the exact
repository migration files through the real runner, and assert preservation of
old rows and compatible existing-column reads/writes plus the new columns,
tables, defaults and widened constraint required by each issue. A sequential
fixture may cover several migrations if every pre-upgrade state and assertion
is explicit; five duplicate full histories are not required. Keep owned pools,
databases, temporary directories and asynchronous work bounded and fully
cleaned up. Historical single-tenant restrictions must be respected or any
fixture-only modification disclosed; owner upgrade fixtures do not replace
current runtime-role RLS evidence.

No historical migration rewrite, production runner change, new package or
release/rollback guarantee is authorized. In particular, preserving existing
notification kinds through the widened check does not prove that an old binary
can interpret newly introduced `semp_problem` rows. Report the actual legacy
read/write coverage and any such limitation precisely. All existing migration
and functional acceptance obligations remain; these scope additions establish
where to prove them, not a passing result.
