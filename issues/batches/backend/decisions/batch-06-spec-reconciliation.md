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
both generic and MCP wrappers. Strip the reserved field and store null; other
non-string and over-500 values remain invalid. Keep the optional-string tool
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
