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

## Categories without a current notification kind

The current closed `NOTIFICATION_KINDS` and database kind CHECK have no
invitation or reminder kind. Gh-1440 already assigns future policy entries to
the issues introducing those kinds; this batch does not introduce them.
`pushInterruptionLevelFor` implements both preference branches, and the actual
fan-out job calls it before loading registrations or claiming delivery rows.
The scoped permanent fan-out suite contains on/off tests with typed synthetic
policies for these two categories.

Clarify gh-1443 Task 3's evidence requirement: execute both switch branches
through that production decision helper and statically verify its actual
pre-claim job call. Record those evidence levels separately. Real-job
integration for invites/reminders is NOT RUN/unreachable under the current
closed catalog and remains for the issues introducing their kinds. Do not
invent kinds, loosen the database constraint, relabel a current production kind
or present a mocked policy catalog as genuine current-kind integration.

This limited clarification satisfies the current branch-test requirement when
those tests actually pass and the wiring is verified. It grants no test PASS
in advance, no general helper-only acceptance exception, and no waiver of job,
queue, storage or transport evidence for existing notification kinds. Reapprove
the exact source and propagated aggregate with updated specification hashes.

## Approval decisions reaching tenant-scoped connected clients

Gh-1463 AC1 names connected clients. An injected data-layer callback and a
separate synthetic NOTIFY test do not establish the composed decision path.
Add exactly
`backend/services/semprec-api/src/__tests__/tenantIsolationRealtime.test.ts`
to gh-1463 and aggregate Touches. That existing runtime-role, two-tenant socket
harness composes the actual dispatcher, sync server and realtime hooks.

Use a real approval decision and its committed notification resolution to
exercise the hook, NOTIFY bridge and actual client wire-frame mapping. Assert
receipt on the intended user's sockets and absence in the other tenant; replay
and rollback must produce no additional read-state publication. Use the
existing ordered sentinel method for absence, not arbitrary sleeps or a
synthetic replacement for the event under test. Respect existing fixture and
resource cleanup. The callback-only tests remain useful for transactional
state, but do not substitute for this boundary. No new realtime mechanism or
production path change is authorized by the added test scope.

## Human label wrapper versus agent capabilities

Gh-1391 Task 2 asks for a wrapper used by the human route while its last AC
imprecisely attributes agent isolation to package non-export. The raw
`setMcpToolDisplayLabel` setter is private; `reclassifyMcpTool` is intentionally
exported for the API service and already accepts `displayLabel`. The handler
uses `authenticateRequest`, which verifies a user session rather than treating
a run credential as that session. Existing backend rules forbid direct agent
writes. Removing the wrapper export would break the specified API composition;
its existence is not evidence that a model has a callable tool for it.

Clarify Task 2 and the last AC, preserving human-route ownership: keep the raw
setter private and the API wrapper exported. No current agent tool,
generic/MCP operation, proposal-confirm path, sync or background job may expose
a capability that writes labels. The worker and independent reviewer must
trace actual catalogs, callbacks and write call sites, retain the human-route
positive control and provide discriminating automated exposure/refusal checks
where applicable in the already scoped label/API suites. An export-name search
alone does not establish capability isolation. A demonstrated agent write path
is a defect requiring repair or a concrete new scope decision, not accepted by
this clarification. Package exports are not an arbitrary-code security sandbox,
and no such guarantee is introduced.

No new actor/token protocol, grants, ownership exception, generic administrative
tool or package dependency is authorized. Reconcile only the misleading raw
setter/export wording. The aggregate's redundant introductory Context is
compacted to retain the 60,000-character limit; all embedded requirements,
model classification, dependency order, scope limits and aggregate gates stay
present. Exact modified source/aggregate records are reapproved and hashes
propagated. No acceptance result is granted.

## Typed test harnesses without provider or database connections

The current APNs suite returns a partial `FakeApnsSession` by asserting it is a
complete `ClientHttp2Session`; the MCP invocation unit suite similarly casts an
empty object to `Pool`. These test objects are internally constructed rather
than parsed external payloads, but the assertions conceal incomplete interface
implementations. No blanket exception to typed test boundaries is granted.

Clarify gh-1445 Task 3 to retain a stubbed `node:http2.connect` while returning
a real typed session backed exclusively by an owned loopback HTTP/2 peer.
The tests remain at the existing unit-tier path and must not access Postgres
or APNs. Capture the actual local request headers/body and preserve every
background/alert payload, status, missing-config, reserved-key and failure
assertion. Bind only loopback on an ephemeral port, bound waits and request
work, settle and close owned streams/sessions/server, and restore spies on all
paths. Parse received unknown JSON as a boundary value. The stub must prevent
a production APNs address from being dialed. This proves the adapter contract
against the controlled peer, not live APNs delivery or provider TLS behavior.
No production injection seam, transport change or dependency is authorized.

For the already scoped `mcpToolExecution.unit.test.ts`, replace the empty-object
cast with a genuine lazy, unconnected `Pool` instance. Installed `pg-pool`
initializes an empty client list in its constructor and opens clients through
`connect`/`query`. Install fail-fast spies on both before invoking code, retain
the fully mocked connection and state-store dependencies, and close the owned
empty pool. No test may connect/query a Postgres server, import the database
fixture/setup, or gain a database URL. Accidental database access must fail,
not be silently accepted. This is test construction using the actual type,
not a new production test-only API or a validation waiver.

The existing topic skills and cleanup/error rules apply. Only gh-1445's named
harness wording changes; MCP unit-file scope is already approved. All functional
Tasks/AC and production contracts remain intact. Refreeze exact source and
aggregate hashes, and require affected tests, build and independent review on
the resulting candidate. No test result or completed gate is inferred here.

## Completed review findings and safe preference errors

The independent review of clean `efe1c92d` completed all 44 Task rows, 47 AC
rows and six aggregate gates with NOT CLEAR: label-key reflection, incorrect
connection timestamp types, overbroad connection-writer parameters, masking
APNs test cleanup, racing realtime absence evidence and incomplete
other-user/different-source isolation evidence. These findings block
acceptance; earlier targeted logs are historical, not final-candidate PASS.

Gh-1441 Task 4's unknown-field wording conflicts with the sensitive-content
error rule when an arbitrary key becomes an error message or `details.field`.
For unknown keys require a fixed message and `details.field = "body"`, with no
rejected names or values reflected in errors, details or logs. Invalid known
fields retain only their canonical field names. Preserve HTTP 400, no-write
refusal including mixed valid/invalid bodies, defaults and empty PATCH. Correct
the source Task and AC and propagate its exact snapshot/approval. Existing
preference and authenticated tenant-route suites cover this work; no new test
path, error code or general response-contract rewrite is authorized.

The label-reflection finding similarly requires fixed safe diagnostics and
real HTTP/store omission and unchanged-state regressions within gh-1391 scope.
The connection getter must return actual ISO strings/null matching its public
type, with checked DB timestamp/reason mapping and real runtime-role evidence.
Do not change the separately formatted gh-1455 listing or global pg parsers.
Both independent writers require `Pool`; the getter may remain `Queryable`.
The new `2026-11-01-mcp-connection-observations-commit-independently` ADR records
the exact observation-state UPSERT exception to the old append-only pattern.
Add that ADR to gh-1450 Task/Touches and aggregate; keep historical ADR bodies
and migrations unchanged. Compact redundant gh-1450/gh-1441 Context without removing
its table, recording rules, ownership decisions, Task/AC or classification.

## Realtime absence requires a causal publication/delivery boundary

A later schema sentinel alone is insufficient for asynchronous read-state
publication and notification-row forwarding. The earlier test-scope decision
does not waive this. Current `withTransaction` invokes after-commit callbacks
synchronously before returning; the wired read-state hook invokes the real
publisher, which calls the same runtime pool's `query` before suspending.
A call-through spy on that exact pool can observe validated matching
`pg_notify` attempts without suppressing or replacing their execution.

The real committed decision must observe the matching read-state publication
and both intended owner socket frames. Receipt follows `sendToTenant`'s
synchronous socket traversal, so only then may a foreign-tenant sentinel be
used to exclude a frame from that completed delivery. For replay/rollback,
await the actual HTTP/transaction boundary and assert no matching publication
was invoked; a racing schema sentinel is not proof of that absence. Validate
unknown query payloads, prove the positive observation uses the actually wired
pool and retain discriminating controls and foreign-row assertions. If the
implementation defers the callback or uses another pool, this reasoning does
not apply and the test design must change.

Keep the actual decision, hooks, NOTIFY, row read and sockets; add no production
drain API or delivery mechanism. This test-only refinement stays in the
already scoped realtime suite and needs focused independent re-review. The
APNs helper must protect owned setup and all cleanup, preserve the original
failure and separately report cleanup failure with bounded settlement. The
gh-1463 different-source case must use real two-tenant runtime-role rows with
own-resolution positive, foreign state unchanged and no foreign read-state
event. All six findings plus the preference correction need affected evidence
and a new clean candidate before final gate; no exception or PASS is granted.

## Explicit Web Push interruption-level omission evidence

The complete execution-binding audit of `c0a415c9` identified a missing
permanent gh-1443 Task 2 assertion after its full verification started.
The production Web Push adapter explicitly serializes its own fields, but
its existing tests never pass a populated `interruptionLevel`; fan-out tests
inject a fake sender. Neither proves this named real adapter boundary.

Add only
`backend/packages/data/src/push/__tests__/webPushAdapter.unit.test.ts`
to gh-1443 and aggregate Touches. Exercise actual `sendWebPushNotification`
with a configured stub of `webpush.sendNotification`, supply the typed
`time-sensitive` interruption level, and check the actual serialized JSON
retains all applicable existing fields while omitting `interruptionLevel`.
Keep the delivered/called positive control so a missing send cannot satisfy
an absence assertion. Preserve existing body omission and other adapter tests.
No production code, network call, dependency, provider credential or client
implementation is authorized. Compact only redundant historical gh-1443
Context to keep the aggregate within its body limit; Task/AC and decisions
remain unchanged and exact source/aggregate approvals are renewed.

The owned full verify was interrupted with exit 130 and is diagnostic only;
its log and before/after identity evidence are retained. E2E was not run.
Do not claim an overall PASS or candidate exception from completed stages.
The interrupted window was released before this refreeze. Finish the entire
Task/AC execution-binding audit and its grouped gaps before the next full
pipeline. After this permanent test is implemented, run affected checks,
review the exact delta and updated evidence binding, and freeze a new clean
candidate for the complete gate. All earlier limits and unresolved external
qualifications remain explicit; no completion or integration is granted here.
