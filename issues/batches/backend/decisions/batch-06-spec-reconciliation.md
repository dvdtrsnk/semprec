# Batch 06 specification reconciliation

Authority: owner-delegated parent controller `thr_pz39tcih5r`, under
`2026-10-31-owner-delegated-backend-program-supervision`. Applies only to the
current backend batch, before candidate acceptance. This changes no completion
state and accepts no implementation or test result.

## Strict user-turn context and propagation

The existing `UserTurnContextRef` index signature and verbatim user-event yield
allow arbitrary expanded content, contrary to gh-1566 Task 3. Its existing
Touches already includes runtime `types.ts`; narrowing that type is authorized.
Add a labeled variant derived from the existing closed shared
`sempMessageRefSchema`, preserving the strict unlabeled schema. Every ref has a
required string label captured at send time. Do not add ref kinds, expansion,
visibility resolution, arbitrary label limits or historical backfill.

Validate incoming context at the real session boundary before yielding or
persisting its user event or prompting the model. Reject malformed refs, invalid
labels and extra/expanded fields; do not log rejected values or message content.
Use validated value snapshots, not a reusable reference to a prior turn's
context. Evidence must distinguish invalid UUID/kind/range/label/extra-field
branches from unrelated guards and retain existing unlabeled behavior.

Keep the leading `SempConversation.send(task, thread, ...)` arguments unchanged.
An optional `context` belongs only in trailing options alongside `signal` and
`onTurnStart`. Validate before dispatch and propagate into wake session options
and continuation `send(task, context)`; omission means an empty array for that
turn. Real composed turn evidence must reach the persisted event before prompt,
including a continuation and a later turn without refs. Callback and cancellation
contracts remain intact; no queue or message producer from gh-1727 is added.
Gh-1398 now declares gh-1566 as an internal prerequisite, already earlier in the
batch's unchanged order. Shared schema/tests and explicit conversation paths are
added to the exact affected Touches.

## Budget error text and machine discriminator

Gh-1547 Task 4 requires `AiBudgetExceededError` with fixed safe message
`AI budget exceeded`, and gh-1446 Task 6 preserves result text. The former final
AC's literal code-only result contradicts these Tasks. Preserve the fixed safe
message in the thrown error and failed run's `result`; store the separate
`errorCode: "budgetExceeded"`. Do not introduce budget-only result rendering at
all closing sites or generalize error redaction from deferred gh-1824. Other
failures keep existing result text.

Captured diagnostics may contain the stable code, operational identifiers and
fixed safe text. Neither diagnostics nor stored result may copy a response body,
request/user content, provider exception message or credential. Test the actual
composed refusal-to-closed-run path and capture logs with distinguishable
sensitive sentinels. The existing service `agentRun.e2e.test.ts` is included for this composed evidence;
model transports remain fake/local and no live provider call is allowed.
Status/header discrimination and per-call concurrency requirements remain intact.

## Identity and evidence

Regenerate the two context snapshots and the budget snapshot, aggregate Touches,
approval digests, manifest hashes and dispatch file hashes. Only redundant
aggregate process prose is compressed to retain its existing character bound;
member decisions and Tasks are preserved with the explicit clarifications above.
The corrected gh-1560 retention chronology tests are independent in-scope evidence
work, not a changed retention contract. None of this proves acceptance: complete
Task/AC audit, independent review and frozen final verification remain required.

## Persisted MCP approval failures

Gh-1444's unavailable approval outcome and actual classified invocation results
were discarded by the store's text/outcomeKind-only serializer. Preserve an
optional nested `failure` in the existing MCP outcome JSONB envelope
`{text,outcomeKind?,failure?}`. Reuse the closed invocation failure contract;
validate new structured metadata on write and when reading it from unknown JSON.
Malformed new metadata fails closed without logging its values. Legacy strings
and objects without failure remain readable; success and cancellation acquire no
failure. A small internal `mcpFailure.ts` type/validator may prevent a runtime
import cycle, while existing type/constant exports stay compatible.

Unavailable approval execution uses the known snapshotted server id; actual
invocation failures survive persistence and later reads. Keep text, legacy
outcomeKind, execution status, tenant scope and claim/redelivery behavior. No
DDL, backfill, reply projection, generic-operation result rewrite or additional
public raw-outcome exposure is authorized. Tests cover real queued execution,
legacy/new reads, malformed metadata and redelivery without duplicate invocation
or replacement of settled evidence. The store and exact execution/store tests
are now in scope.

## Approval reasons and strict REST DELETE

Gh-1420 already requires REST item.delete to reject reason. The actual item
DELETE adapter ignored its body and could perform that deletion. Its sole route
scope exception is now explicit: require an empty object after existing parsing
(which maps a bodyless request to `{}`), rejecting extra fields including reason
and non-objects with the existing 400 validation response before dispatch. Prove
no mutation under authenticated HTTP, plus bodyless/empty-object success. Do not
change other routes, strict operation schemas, `/mcp` or global body parsing.

For agent-only optional reason fields, preserve null-as-absence consistently in
both generic and MCP wrappers. Strip the reserved field and store null; reject non-string values actually
reaching a wrapper and over-500 strings. Earlier SDK coercion is preserved, as
clarified below. Keep the optional-string tool
schemas and existing provider normalization; do not add a raw-model interceptor.
This tolerance applies to optional approval reasons only, not context refs or
REST reason input. The failed null-rejection experiment remains diagnostic.
Actual composition tests must exercise the provider-facing behavior honestly.

The runtime package has no queue dependency, so its MCP unit/integration fixture
cannot import the queue executor without changing the package graph. Place the
composed gated-tool -> decision/enqueue -> actual API core task -> local MCP
server scenario in the existing service `agentRun.e2e.test.ts`, explicitly included
in gh-1420 and gh-1444. That service already depends on runtime and queue. Use
public `createCoreTaskList`, `decideAndEnqueueApprovalRequest` and queue `runOnce`;
`createAgentTaskList` does not host approvalExecute. Prove the stripped reserved
reason is absent from actual server arguments and preserve classified outcomes.
Keep useful lower-package tests, but remove their provisional unresolved queue
imports. No new production dependency/export, lockfile change or downward import
of the service is authorized. The failed module-load run is diagnostic, not a
functionality PASS; report the actual E2E tier/count after adding this scenario.

## Startup repair composition evidence

Gh-1374's existing service startupRepairComposition test may run actual repair,
read the stored history, reconstruct it and call production toPiMessages. This
avoids a forbidden runtime-to-service import and proves the complete requested
chain rather than converting a separately manufactured object. Historical-row
rewrites and unrelated repair behavior remain excluded.

The additional Touches apply only to these existing requirements. Preserve every
member decision and behavioral clause; compress obsolete descriptive Context and
redundant aggregate instructions only to respect the existing size bound. This
refreeze is not implementation acceptance or a verification exception.

## Realtime user-message evidence

Gh-1566 explicitly requires agent:watch replay and watcher agent:event support.
The data-store listing helper alone does not prove these boundaries. Include the
existing backend realtime `syncServer.test.ts` for an actual authenticated,
tenant/owner-scoped WebSocket scenario: persist a user_message, replay it through
agent:watch, then deliver a later live user_message as agent:event and assert the
payload and order. Use existing production publication and deterministic frame
synchronization; do not replace the boundary with a direct list query. If an
absence assertion is needed, use the existing ordered-sentinel pattern rather
than a sleep. Preserve production authorization, protocol and isolation; report
any discovered production gap separately. No realtime source or client change
is authorized here. Obsolete descriptive source Context is compressed, retaining
its contracts, references and all Tasks/ACs.

## Known server id on a direct unavailable result

Gh-1444 already requires a known server id on unavailable results, while
resolveGrantedMcpTool deliberately returns indistinguishable null for unknown,
inactive and revoked tools. Do not weaken that resolver or add an unscoped lookup.
The per-run composition already holds the authorized grant's registration/server
pair. It may close over that validated UUID as optional factory metadata and
attach it when current resolution rejects as unavailable. No snapshot means no
id; a successful resolution uses its fresh target, never the fallback snapshot.

The snapshot comes only from the existing server-derived per-run grant listing,
bound to that tool's run/project/registration. It is not an agent argument,
transport setting, per-call override, authorization grant or credential. Never
infer a registration/server relationship from model-supplied ids. Current
invoke-time authorization and approval decisions remain unchanged; a stale
snapshot cannot permit an invocation or create an approval request. Preserve the
same unavailable text, no extra lookup and no transport access on rejection.

The existing runtime/server-composition Touches cover the optional factory seam
and tests. Prove actual authorized composition followed by revoke/disable returns
unavailable with its already-known id, does not invoke the server and creates no
request. Prove a caller without a snapshot receives no id even if args contain a
forged hint. Preserve unknown/foreign/revoked rejection and use the existing
safe UUID convention for optional factory metadata. Do not change REST/MCP wire
arguments or add public endpoints, exports or package dependencies.

This applies the existing server-derived-context contract in mcpToolInvocation
and the frozen known-id requirement to diagnostics; it grants no new authority
and changes no claim/external-call/outcome state machine from
2026-09-29-exactly-once-execution-of-deferred-mcp-tool-calls. Historical ADR bodies
remain unchanged. No Task/AC/Touches or approval digest changes are required.
The separate reviewer must inspect this metadata/auth separation with the rest
of the complete batch.

## Open follow-up: writes before the session failure handler

Static audit identifies a preexisting risk in SempConversation.send: the newly
created run's running-status publication and compacted-history persistence occur
before its session try/failRun handler. A rejection there can leave the run
running until later startup repair. No injected-write reproduction is recorded
by this decision. Gh-1398's factory/callback/signal Tasks and gh-1446's code-on-close
Tasks do not request this broader lifecycle repair; a title alone does not expand
them. Leave that control flow unchanged and record this OPEN follow-up in the
review brief and final evidence. Do not claim that all failures universally close
runs. A regression caused or worsened by the current batch remains in scope and
must be distinguished from this preexisting path. This deferral neither fixes the
risk nor accepts a failed in-scope criterion.

## Historical migration lock clause

Gh-1452 Task 1 explicitly requests an ordinary CREATE INDEX. Its former AC's
no-full-table-lock wording conflicts with that SQL and the actual migration
runner. PostgreSQL documents [ordinary index SHARE locks and lock lifetime](https://www.postgresql.org/docs/16/explicit-locking.html)
and the [default ALTER TABLE ACCESS EXCLUSIVE mode](https://www.postgresql.org/docs/16/sql-altertable.html).
The local runner executes each entire file between BEGIN and COMMIT. Therefore
0096's ADD COLUMN ACCESS EXCLUSIVE lock persists through the index build until
commit, blocking reads as well as writes. NOT VALID skips the initial foreign-key
validation scan; it does not release the earlier stronger lock. The proposed
interpretation that only a separate index SHARE lock matters is rejected.

Preserve historical executable 0096/0097 SQL, ordinals and the per-file runner.
No CONCURRENTLY command inside its transaction, runner redesign or global
migration-policy exception is authorized. Correct only 0096's misleading comment
that calls the lock brief; do not replay or renumber that migration. The separate
0097 VALIDATE phase and populated data preservation remain required.

Replace the impossible AC with truthful local evidence: real populated runner
upgrade, initially unvalidated then validated constraint, and a bounded lock
scenario observing 0096's actual granted lock while its transaction is held,
concurrent read/write waits and successful settlement after commit. A test-owned
barrier after the real file work and before commit is sufficient; do not replace
the production DDL with a manually acquired table lock or change production runner
code. Release gates, settle all operations and close owned pools on failure.
Existing migration-test scope covers this scenario.

This accepts neither measured lock duration nor concurrent availability or a
production rollout. Production scheduling, dataset size and online-index design
are not established here. It retains the frozen Task's existing SQL and records
its actual limits for local delivery; general expand/contract guidance remains
unchanged. Include the corrected source AC, decision and observed versus inferred
facts in the review ledger and acceptance evidence, without marking the old
no-lock claim PASS.

## Startup repair matches the complete history

Independent review identified gh-1374 AC5's last-event wording as incompatible
with its own "as before" intent. Both current code and integration base b2230f13
call findDanglingToolUses over all stored events, preserving id-based and
anonymous matching. An unmatched earlier call followed by a non-tool event can
therefore still require a synthetic result. The issue changes result shape,
not which eligible runs or unmatched calls are repaired.

Correct AC5 to the existing whole-history behavior. An eligible interrupted run
with no unmatched call gets no synthetic tool result; an earlier unmatched call
followed by an ordinary event still gets one. Preserve existing eligibility and
exemptions, matching rules, and original interruption text. Add actual repair
regressions for this positive case and matched/no-call negatives in already
scoped tests; do not implement a last-event-only filter or rewrite old rows.
Preserve the original reviewer finding and obtain focused review of the revised
clause and evidence. All other Tasks/ACs and historical ADRs remain unchanged.

## Atomic thread-filtered checkpoint boundary

Gh-1560 explicitly names persistCompaction, so correct caller pairing alone is
insufficient. Reuse the existing withTransaction and getAgentRun FOR UPDATE
contract: validate the target session key under tenant RLS, then insert on the
same client. Thread mains require their explicit filter; optional legacy paths
remain for other runs, and supplied legacy keys must match completely and exclude
thread mains. Reject mismatches without an event; missing and foreign targets
remain indistinguishable. Compute compacted entries before locking; no provider
work or content-provenance traversal is added to this short transaction.

Pass the thread filter from SempConversation and route its compaction await
through the existing failRun handler, preserving the original error and avoiding
any prompt on failure. This supersedes only the compaction part of the earlier
pre-session-write deferral because the new guard introduces a deliberate failure
there. The initial running-status publication remains an OPEN preexisting
follow-up. No general lifecycle refactor is authorized. Existing store APIs and
[[2026-09-29-withtransaction-is-the-sole-transaction-opener]] cover this transaction
pattern; no new advisory lock, store export or migration is needed.

Runtime-role success/refusal cases and a bounded forced-overlap mutation must
prove that validation and insertion share the held row lock. Matching legacy
sessions remain compatible. The exact source Task/AC and caller/test Touches are
refrozen; prior independent review carries forward only for unchanged clauses.

## Index eligibility rather than a forced physical plan

Gh-1560's index wording means thread/tenant predicates compatible with the one
existing tenant/thread/wake index, not an unconditional planner choice. PostgreSQL
[chooses plans from query and data properties](https://www.postgresql.org/docs/16/using-explain.html).
A small fixture's sequential scan is not by itself a failure. An owned populated
fixture may capture EXPLAIN of the actual query under its real tenant role and
normal planner settings, recording row counts and the actual plan. Do not disable
sequential scans, force a plan, add a second index, or generalize one measurement
into a production performance guarantee.

## SDK normalization and reconstruction boundaries

The pinned pi validateToolArguments clones arguments, normalizes optional nulls
and applies value conversion before tool execute. Numeric/boolean optional reasons
can therefore arrive as strings. Preserve the existing no-interceptor decision
and optional-string schemas: reject nonstrings actually reaching each wrapper,
and disclose/test SDK-coerced stored strings separately. Reserved-field stripping,
null-as-absence, length validation and strict REST rejection remain unchanged.
Do not claim raw-model rejection from a later wrapper test.

For newly introduced user_message history, validate required string text and its
strict labeled context at the stored-row and compaction-entry read boundary.
Malformed fields fail with content-free diagnostics; no silent default/backfill.
AgentMessage itself promises kind plus unknown extras, not fully validated fields
for every old event variant. Remove avoidable structural-access casts in the
existing guards but preserve compatible legacy per-kind behavior and unknown
metadata. A new schema project for every historical kind is not authorized.

## SDK-erased MCP HTTP status

Apply the current-batch correlated-transport-error ADR. Local negative controls
show an SSE tools/call POST 401/403 can become an untyped SDK Error and fall through
to toolError. Approved scope includes the private observational helper, exact
factory boundary, test fixtures and ADR; it permits no early fetch throw or
response/OAuth-flow modification. Preserve original errors and correlate only
checked status with the exact rejected operation, including retries and setup
notifications, without retaining body/credential content or ambient status flags.
The separate reviewer must assess races, precedence and all declared local
transport cases; existing failures or diagnostic-only probes are not a PASS.
