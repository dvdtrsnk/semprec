# Batch 13 specification reconciliation

## 1. Bounded OAuth rotation transaction exception

Owner-delegated controller thr_pz39tcih5r confirms gh-1481's explicit
credential-lock/exchange/persist transaction conflicts with the general
external-call bracketing ADR. Adopt the narrow additive decision
[[2026-11-02-mail-oauth-rotation-holds-the-credential-lock-through-refresh]].
The accepted historical ADR body is unchanged. This permits only the mail OAuth
refresh owner to hold its tenant credential lock across one bounded request;
it does not authorize arbitrary HTTP in transactions or change mail-thread
guards, SMTP sending, provider sync or approval ownership.

The waiter uses the committed replacement refresh credential in its own
exchange. There is no shared access-token cache. The at-most-once assertion is
for successful committed rotating generations, not repeated use of a valid
nonrotating token or recovery from an ambiguous provider/database outcome.
Preserve 400/401 reauthorization mapping; reject without returning an access
token on persistence/commit failure and retain the documented uncertainty.
No automatic replay, new schema or generic transaction mechanism is authorized.

Gh-1481 Touches now include the additive ADR and the existing
oauthTokenExchange.test.ts for its request deadline/body-cap evidence. Other
implementation and overlap evidence stays in mailOAuthAccess.test.ts. Verify
real runtime tenant isolation, both overlap orders, generation ordering,
independent progress, no return before commit and failure cleanup with owned
bounded resources. Deadline or cancellation alone is not settlement. Keep
secret/error/log assertions discriminating and live provider checks NOT RUN.

Gh-1569's verification-specific TLS classification, deadline and connection
ownership seam is a separate pending adjudication. This section grants no
change to mailServerConnections, default privacy mappings or helper lifecycle.
Continue unaffected member work while that decision is prepared.

## 2. Verification-owned mail connections and limited TLS diagnosis

The parent inspected the installed nodemailer public socket seam and the shared
policy factories. Gh-1569 cannot reconstruct certificate errors after they have
been erased, nor cancel an IMAP client before the helper returns it. Adopt
[[2026-11-02-mail-credential-verification-owns-bounded-policy-connections]]:
one closed verification path in the existing helper owner, preserving normal
sync/send/IDLE behavior and denied-address privacy. No new SMTP protocol,
private-library interception, global TLS patch or plaintext authentication.

This explicitly reconciles the original all-TLS-failures diagnosis: definite
machine-readable TLS/upgrade refusals map to mail_tls_failed; ambiguous socket
or TLS failures map to mail_server_unreachable. Both reject verification.
Candidate exhaustion prioritizes observed authentication, then definite TLS,
then unreachable. Real certificate/STARTTLS/timeout tests must assert the actual
supported category, not manufacture a lower-level error the library does not
provide. No claim of complete SMTP certificate diagnosis is accepted.

The 15-second whole-attempt limit includes DNS through authentication. The
helper owns cancellation, network teardown and guarded late completion. OS DNS
work may outlive the deadline but must be unable to dial; finite injected DNS
callbacks are settled before test seam restoration. A raced timeout without
owned closure and terminal settlement does not satisfy this decision.

Gh-1569 Touches adds mailServerConnections.ts and its existing test, providerTypes.ts
only for safe verification categories, adapter errorContract unit tests, and
publicSurface.test.ts only for deliberate new public verification/error exports.
Do not change unrelated stored state, outbound policy/resolution rules, default
timeouts or other adapter behavior. Original gh-1478 handover and accepted ADR
bodies remain immutable. This scope supersedes section 1's temporary hold for
these exact changes; all implementation/review/runtime gates remain required.

## 3. ImapFlow pre-connect cancellation ownership

The parent verified ImapFlow 1.7.6 clears its timer in close() before it has an
initialReject callback during pre-connect. Adopt the additive compatibility
decision [[2026-11-02-mail-verification-cancels-imap-through-owned-sockets]].
One checked read-only socket accessor, local to the existing verification
helper, captures actual Socket identities and terminal events. Cancellation
destroys that socket with a fixed owner error while library handlers remain,
awaits actual connect settlement and then performs final public close. Neither
an earlier inner timer nor ImapFlow's synchronous close event proves settlement.
No private-field writes, dependency patch, SMTP interception or new transport.

The parent library-only held-DNS diagnostic in private evidence is supporting
design evidence, not a production test or gate. Its delayed callback returns no
network address. The worker must exercise actual helper phases, late completion
and independent error outcomes before review. Normal adapters remain unchanged.
This adds only the new ADR to gh-1569 Touches; source/test paths already belong
to section 2. Embedded requirements stay complete; the aggregate's redundant
top-level Context alone is compressed to remain below its metadata size cap.

## 4. Known cancellation primary and separate secondary diagnostics

The parent inspected the five-stage development run: three cases pass; stalled
LOGIN and post-STARTTLS cases retain the owned cancellation plus independent
library errors in an AggregateError. These are development failures, not a
passed gate or proof that cancellation caused every later error.

Apply the existing error-handling rule that a cleanup observation does not
replace an established primary failure. Only if the actual connect() rejection
is the exact owned cancellation Error may this known deadline primary become
the existing unreachable verification outcome, after actual operation/socket
settlement. A timer flag, temporal proximity, authenticationFailed flag or
generic error code is insufficient. If connect() rejects another value, this
clarification grants no conversion of it to cancellation or authentication.

Retain non-owner secondary observations separately with their original values,
presence and observation order until settlement/diagnostic processing completes.
Do not mark them as expected cancellation or infer their cause. Emit a fixed,
safe structured application diagnostic recording their count, closed source
and category tags, and observation order for this attempt. Do not publish raw
exceptions, messages, causes, addresses, credential material or arbitrary name/
code fields. Unexpected secondary observations remain observable; the outward
known timeout does not become a false authentication refusal. This uses the
existing logger and existing failure taxonomy, not a new public diagnostic API,
persisted error store, broad exception filter or private library interception.

Errors observed before owned cancellation, unsuccessful destruction, incomplete
connect/socket settlement, and unknown actual connect rejections retain their
failure behavior. Do not continue to another endpoint with work outstanding or
let a later cancellation flag retroactively consume an earlier unknown error.
Diagnostic emission must not be falsely reported as successful if it failed.

Permanent finite controls must prove the exact real connect rejection identity,
owner action and secondary observation ordering, actual socket closure and safe
serialized diagnostic. Include a distinct unexpected secondary (including a
non-Error value) retained by identity in the actual observation path, and an
earlier unrelated connect failure that is not recategorized after timeout.
Forwarding observation of the real producers can establish source identities;
do not add a generic production test callback solely for introspection. Retain
the two failed logs. All changes remain in the section-2/3 source/test scopes;
this clarifies known-primary handling under their existing lifecycle/privacy
decisions, without changing source requirements, approvals or default adapters.

## 5. Fast STARTTLS terminal-state proof

Adopt [[2026-11-02-imap-starttls-cleanup-proves-the-underlying-transport-closed]].
The actual initial TCP close event plus the checked same-attempt STARTTLS
wrapper's terminal state and settled operation/cleanup can prove teardown even
if the wrapper's own historical close event was missed. Socket.closed alone is
not sufficient on the installed Node. Do not claim that the missed event was
observed, add constructor interception/polling or loosen certificate checks.
Retain actual failures and prove both complete and incomplete terminal-state
branches. The existing source/test scope is unchanged; only the new ADR is added.

## 6. Forward repair for null-activity mail sync errors

The real pre-0115 upgrade test reproduces a permitted row with last_error set
and last_activity_at NULL whose failure kind remains NULL after 0115. Retain
0115 byte-for-byte: changing an applied filename would not repair existing
databases. Do not infer historical provenance that the stored state lacks.

Authorize a narrow idempotent data repair through the already queued
MAIL_ACCOUNT_SYNC_SWEEP, after its existing due-account enqueues. Per active
tenant and sweep, repair at most 200 rows where last_error IS NOT NULL,
last_activity_at IS NULL and last_failure_kind IS NULL, using one row-locked
withTransaction page and rechecking that predicate at the write. Set only
last_failure_kind to other. Preserve every timestamp, cursor, scheduling field
and item. Do not invent failing_since, last success or initial-completion time.
Rows with known kinds, non-null activity or no error are outside this repair.
No new DDL, task name, crontab, job registry or migration progress table.

This also labels indistinguishable current invalidation-only rows meeting that
predicate as other, meaning an unclassified stored error, not proof of a failed
sync pass or its onset. Existing invalidation writers are unchanged. Repair is
eventual over successful sweep executions; contention-skipped rows retry in a
later sweep. It does not promise that SQL migration alone repairs all records,
that inactive tenants are processed, or that a release has run this repair.

Use the existing tenant fanout, public queue/runtime handler and retry behavior.
Keep the mail state store as writer; no item update, notification or provider
I/O belongs in the repair. Recheck row predicates under actual row locks so a
new success/known failure cannot be overwritten. Already committed pages remain
committed if a later sweep fails. The predicate makes repeated and concurrent
runs idempotent without a persistent cursor; each completed repair drops out of
the next page. This follows the existing forward-only, separate data-backfill
and bounded-sweep decisions instead of adding another deploy cutover.

Gh-1497 Touches explicitly includes existing mailSync.test.ts and the prepared
mailSyncStatusMigration.test.ts for actual historical upgrade plus queued repair,
runtime-role two-tenant/exclusion, repeated runs, multi-page bound and competing
state-write controls. The old mailSyncJob.test.ts path is corrected to the real
mailSync.test.ts harness. Existing store/job paths suffice for implementation;
no broad migration or scheduler scope expansion. The original failing upgrade
log remains evidence of the old gap. All final review and runtime gates remain.

## 7. Unknown verification failures at the privacy boundary

Adopt [[2026-11-02-mail-verification-sanitizes-unknown-failures-at-its-public-boundary]].
Unknown failures remain failures, with exact original primary/secondary values,
presence and order retained internally through actual settlement and diagnostic
processing. They do not retain identity across verifyMailCredentials's outward
privacy boundary: throw a fixed generic Error without raw cause/properties or
aggregate members, stop candidate traversal, and emit only closed safe metadata
through the existing logger. An unknown error is never authentication, TLS or
unreachable merely because it occurred during verification. A diagnostic failure
also remains a safe outward failure, without a claim of successful logging.

The existing typed sanitized helper outcomes and section 4's exact-owner
cancellation precondition stay intact. Existing source/test paths suffice;
only this additive ADR is added to gh-1569 Touches. Forwarding observations of
real producers must prove internal identity and complete cleanup separately
from outward sanitization, including undefined/non-Error, combined cleanup and
secret-bearing nested failures. No public raw-error seam or durable store.

## 8. SMTP send and IMAP sync provider-error privacy

Adopt [[2026-11-02-smtp-and-imap-sync-isolate-secret-bearing-provider-failures]]
for gh-1634 and gh-1510. Their explicit password/body privacy requirements take
precedence over outward identity of arbitrary provider errors. Keep originals
internally through the owning operation's settlement/cleanup and safe diagnostic
processing, then throw fixed generic unknown failures without cause/properties.
Known classifications stay known with fresh safe error text. Never label an
unknown error authentication/unreachable merely to sanitize it.

SMTP includes its synchronous opener, send and mapping. After actual acceptance,
preserve the existing result for close/Sent-copy failures and report safe fixed
diagnostics; no duplicate-send retry or claim that cleanup/copy succeeded.
Only diagnostics of the existing Sent-copy branch are in scope, not its lifecycle.

IMAP includes the initial connect boundary plus narrow library-operation and
lazy-stream boundaries in ImapFlowMailClient. A whole reconcile/job catch would
also convert SQL/domain/storage failures and is not authorized. Preserve those
identities and transaction semantics, known caps and recovery behavior. The
existing job stores/rethrows the sanitized provider error. Shared connection,
stream and close log sites need closed tags rather than arbitrary names/codes,
raw values or hosts. Other helper mappings/defaults remain unchanged; this is
the explicit narrow log-projection exception to earlier default preservation.

Existing SMTP source/test paths suffice. Gh-1510 Touches expands only to the
private library/stream privacy boundaries and diagnostics in imapFlowClient.ts,
the unsafe diagnostic sites in mailServerConnections.ts, and existing tests
mailSyncAdapters.test.ts, mailServerConnections.test.ts,
imapFlowClientClose.unit.test.ts and mailSync.test.ts for the composed stored-error
boundary. No mailSyncJob production redesign, new public types/framework,
schema, provider parser, private/global interception or new timeout protocol.
Prove secret-bearing arbitrary failures, genuine known outcomes, actual cleanup,
accepted-send behavior, stored last_error and serialized logs independently.
Non-network failure identity is a required negative control. Development passes
that omit these branches are not evidence for the new privacy contract.

## 9. Gmail and Graph sync bearer failures

Adopt [[2026-11-02-bearer-sync-failures-stay-private]] for gh-1505/gh-1508.
After token acquisition, narrowly isolate sync fetch/body failures and Graph's
lazy attachment source failures before they reach the job's last_error writer
or queue. Keep exact original values internally through owned cleanup and safe
diagnostic processing, then expose fixed generic errors without raw cause or
properties. Unknown is not auth/unreachable. Do not wrap token acquisition,
SQL/domain/storage or the entire reconcile/job; preserve their identities and
existing transaction/refresh behavior.

Preserve genuine Gmail 404/history and Graph typed 404/410/cap semantics. Graph
well-known-folder discovery may swallow only an actual typed 404, not arbitrary
provider/body/token failure or another status. This explicit behavior correction
prevents privacy conversion from becoming silent success. Request/attachment
error contexts must not echo URLs/cursors/IDs that can contain provider data.
Graph stream failure and consumer teardown must settle the owned source and
transform without replacing independent downstream errors or buffering the body.

Expand each existing REST source Touches from injectable-fetch-only to these
finite sync privacy sites, plus its existing corresponding REST unit test.
Existing mailSyncAdapters.test.ts supplies composed job/stored-error evidence.
No production mailSyncJob rewrite or new public types/utility framework. Gmail
modify/send and Graph patch/write/send/draft/upload/delete remain outside this
decision; their separate delivery/flag semantics are unchanged. Earlier SMTP,
IMAP and verification decisions do not acquire broader scope by analogy.
Prove all actual failure surfaces, unknown identity retention before the public
boundary, safe stored/serialized errors, genuine status/refresh positives and
non-network identity negatives before independent review or gates.

## 10. Alias export and purge test harnesses

Gh-1493 Task 4 already requires tenant export and purge of mail_thread_aliases.
Authorize the existing tenantExport.test.ts and tenantPurge.test.ts harnesses
solely for alias fixtures and assertions through their actual production export
and purge paths. The current additions create aliases through createMailThread
and reassignThread for two tenants, check exported tenant-local alias rows,
and include aliases in the real purge/retained-tenant assertions. Keep existing
archive/purge behavior and unrelated assertions intact; no production export,
purge or table-discovery redesign is authorized.

Add these two exact data-package test paths to gh-1493 and the aggregate Touches.
The original Task/AC and immutable handover do not change. The existing passing
development log remains development evidence, not a final candidate verdict;
both complete affected files belong in the final named targets and independent
binding review. No new architectural pattern or ADR is needed for using the
already requested production test boundaries.

## 11. APPEND test reconciliation after the frozen unit failure

Actual full verify on ec404737 exited 1 in the unit tier: the existing
imapFlowClientAppend.unit.test.ts expects the original refusal object, while
section 8 deliberately changes unknown provider errors from the reused wrapper
to a fixed safe error. Retain this privacy contract. The failure needs repair,
not a local exception; earlier batch exceptions do not apply.

Add backend/packages/data/src/**tests**/imapFlowClientAppend.unit.test.ts to
gh-1510 and aggregate Touches solely for that reused-wrapper privacy contract.
Observe the original refusal producer independently, assert the fixed generic
failure and absence of raw cause/properties/secrets, and retain the existing
bytes/flags/success/deadline assertions. The test is still a real invocation
of ImapFlowMailClient.appendMessage; do not bypass it or relax the failure to
mere rejection. Correct the now-false original-refusal docstring in the already
scoped imapFlowClient.ts. Necessary typed fixture cleanup in this exact test
helper belongs to this scope, without a protocol or Sent-copy lifecycle redesign.

Preserve the full failed log and manifest evidence. The previous source review
and named passes remain evidence for ec404737, not gates for the repaired SHA.
Use the same reviewer for the focused actual delta and complete unchanged-byte
ledger reconciliation, including the current approvals. Then rerun the complete
named stages with this file included, STOP and separately run full verify on
the new exact clean SHA. No test-filter or environment workaround.

Do not run the skipped E2E tier on ec404737: this candidate already requires
repair. The repaired final candidate must execute the actual
vitest.e2e.config.ts tier before acceptance, normally through full verify. If
that new full run stops before E2E, preserve its exact failure and request the
parent's candidate-specific decision for a separate same-SHA E2E stage; neither
old E2E nor named integration tests substitute. No merge/completion/acceptance
or successor dispatch is authorized by this test-path reconciliation.

## 12. OAuth caller-fixture scope after the integration gate

Full verify on e7e6c8a8 exited 1: its unit and block-model tiers passed, then
integration reported 23 Gmail/Graph transport fixture failures, one historical
alias-upgrade timeout and one MCP inherited-name mismatch. Keep this exact FAIL.
The Gmail/Graph refusals originate at the required fail-closed OAuth tenant
guard; weakening that production guard or send behavior is not a repair.

Add backend/packages/data/src/**tests**/gmailTransport.test.ts and
backend/packages/data/src/**tests**/graphTransport.test.ts to gh-1481 and the
aggregate Touches solely for caller-fixture compatibility with that guard.
Run the existing asynchronous test operations and necessary setup/queries in
their actual test-tenant scope, using the existing runInTenant/inTenantZero
helpers. Scoping factory creation alone does not scope a later send/refresh:
the complete awaited operation must remain in its tenant. Keep all original
send/MIME/recipient, rotation, credential-purpose and refusal assertions.
No global/default production tenant, guard bypass, changed provider behavior,
relaxed assertion or new production send scope is authorized. Existing runtime
OAuth isolation controls remain; no additional owner/foreign transport test is
required merely for these fixture corrections.

The one authorized complete unfiltered alias-file diagnostic on unchanged
e7e6c8a8 passed 6/6 at default timeouts, including the historical upgrade. Parent
verified its result/log hashes and matching root manifests. This establishes
only that run and its passed-path cleanup; the earlier timeout's cause and
post-deadline settlement are not established. Do not change the alias test,
timeouts or migration behavior on this evidence, label the failure flaky or
repeat diagnostics. Preserve the earlier failed gate and the later diagnostic
separately; include the complete alias file in the repaired candidate's fresh
named and full stages. Any recurring frozen failure needs its own diagnosis.

No exception is granted for the extra __CF_USER_TEXT_ENCODING MCP name. Do not
change that test, environment inheritance or subprocess configuration. Any later
candidate-specific local exception requires the exact new full-gate result and
supporting context, not this older occurrence or a previous batch waiver.

After fixture repair, use the same independent reviewer for the actual scoped
delta, current approvals and complete unchanged-byte 48/55 reconciliation.
Rerun fresh exact-SHA named stages/STOP and a separate actual full verify.
Do not run skipped E2E on e7e6c8a8, which already needs repair; the repaired final
candidate must execute the real vitest.e2e.config.ts tier under section 11.
No final gate, acceptance, merge/completion or successor dispatch is authorized
by this compatibility scope decision. No new ADR or source Task/AC change.

## 13. Owner-directed review convergence limit

The owner explicitly requested a reasonable review boundary instead of endless
new rounds. Apply CONTROLLER.md's two-round automatic budget: one complete
initial review and one focused check after a bundled repair. The parent then
disposes of remaining findings; optional test combinations, cheap lows and
speculative follow-ups do not automatically restart review. Concrete security,
data, behavior or explicit Task/AC failures remain blocking and must be resolved
honestly. Extra independent review requires a recorded narrow material reason.

Batch 13 has already exhausted that budget. This supersedes section 12's request
for another reviewer turn on the pending tenant-fixture repair. The worker
self-reviews and runs both complete affected files, then returns the exact diff
and evidence for parent inspection. Retain prior independent reports and carry
unchanged reviewed production bytes; do not claim the reviewer inspected the
new SHA. No new reviewer thread, full-ledger replay or automatic CLEAR loop.
After the parent verifies this routine repair, fresh exact-SHA runtime gates
remain required. This process limit grants no pipeline waiver or acceptance.
