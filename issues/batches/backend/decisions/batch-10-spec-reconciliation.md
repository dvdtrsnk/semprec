# Batch 10 parent scope decisions

Owner-delegated controller: thr_pz39tcih5r. These decisions authorize scoped
implementation and exact refreeze; they do not accept a candidate.

1. Gh-1474's claim-removal contract is violated by two reproduced concurrent send
   schedules. Insert-first cleanup fails its thread foreign key and rolls back the
   failed claim deletion; cleanup-first makes the competing reply fail its foreign
   key. The database prevents dangling references. Neither observed result proves
   a deadlock. Preserve both negative diagnostics and exact participant evidence in
   batch-10-run/mail-overlap-initial.log and mail-overlap-diagnostic.ts.

   Use the new ADR
   `2026-11-01-mail-thread-mutations-use-a-tenant-transaction-guard`: a tenant-wide
   transaction advisory guard, real scope and READ COMMITTED, before participating
   thread/member/alias decisions and metadata locks. Resolver, send cleanup, ingest
   before savepoint, both backfill page transactions, per-item legacy migration and
   IMAP/Gmail/Graph reconciliation participate. Gmail order is tenant thread guard
   before its existing mailbox guard. Preserve existing thread/alias and claim
   semantics. Original SMTP error precedence survives genuine compensation failure.
   No provider I/O moves into send transactions. Existing sync/storage I/O under
   their already broad transactions is an explicit limited consequence, not a
   claim that all provider work is outside locks or that deadlocks are impossible.

   Exact source/test/ADR Touches are added to gh-1474 and embedded unchanged into
   its aggregate. This expanded cross-owner lifecycle/concurrency Task is high
   complexity; update its model tier and rationale under owner delegation.
   Required evidence includes both send and ingest acquisition orders, successful
   failed-draft retry, shared/live alias targets, overlapping bridge/backfill,
   provider-ID savepoint continuation, rollback release, real tenant isolation and
   missing/system/isolation refusals. Prove exact blocked participants, complete
   bounded settlement and actual state, not merely query order or Promise.all.
   Preserve all ten original handover bytes. No schema migration, dependency,
   generic DB infrastructure, provider lifecycle redesign or client work is added.

2. Replace the aggregate's duplicated top-level Touches index with a binding
   reference to the exact union of the embedded per-source Touches sections. This
   avoids the 60,000-character limit without deleting a source Task, AC, scope
   restriction or authorized path. The independently approved source snapshots
   remain fully embedded. Manifest and dispatch hashes are refreshed together.

3. Gh-1396 adds the exact provider-side outbound buffer contract in
   `2026-11-01-streaming-transcription-provider-outbound-buffer-limit`. Use 262144
   bytes including UTF-8 JSON/base64 frame length and current bufferedAmount;
   projected equality is allowed and overflow fails before send. Every provider
   event passes the same gate. A pending configuration failure rejects open;
   established sessions fail once through provider_error and settle accounting.
   Require controlled adapter boundary/teardown tests and actual gateway error plus
   no-reserved-row evidence, with no live probe or configurable capacity. The
   incoming gateway queue and realtime-invalidations refetch policy do not prove
   or define this audio buffer. Existing provider/test Touches remain and the new
   exact ADR path is added. This accepts no code or test result.

4. Gh-1381 uses the route-specific new ADR
   `2026-11-01-completion-body-rejection-uses-bounded-discard` for the streaming
   8 MiB cap refusal: preserve non-destroying iteration, fixed JSON413 with
   Connection:close before resume, discard without accumulation for at most
   2097152 additional bytes/2000ms, then destroy and remove owned timer/listeners
   idempotently. Preserve no-provider/no-reservation behavior. Require actual
   9 MiB HTTP413 and bounded oversized/slow/abort controls, not catch-any-error
   acceptance. Prior EPIPE is an observed transport limitation, not proof every
   client receives413. No other handler, generic drain infrastructure or client
   change is authorized. Exact existing handler/test paths remain; add only the
   new ADR path to source Touches. Current prototype and development pass are
   unaccepted until review and final-candidate execution.

5. Gh-1396 uses the new
   `2026-11-01-stt-stream-close-waits-for-accounting-ownership`: the existing frame
   queue owns started reservations, provider open, settlement/failure and retries
   until idempotent stream cleanup completes. Mark done/abort immediately, then
   wait the final queue tail outside its active callback before closing the last
   chunk and releasing registry/slot. CloseAll and the existing shutdown hook
   cannot race ahead to pool closure. No self-await, parallel final accounting,
   generic shutdown rewrite or detached retry is authorized. Preserve existing
   terminal DB-failure estimate/reconciliation policy rather than inventing
   unconditional no-reserved-row success during outage. Require actual blocked
   reservation and settlement/closeAll ordering, retry/failure and idempotency
   controls under the exact gateway runtime role, with bounded owned settlement.
   Add only the new ADR path to current handler/service-test scope; current
   shutdown source ordering is used unchanged.

6. Gh-1381's 9 MiB evidence means a constructed declared image-bearing request
   streamed toward the unmodified endpoint, with actual complete HTTP413 JSON and
   no provider/reservation. The client attempts its body under backpressure until
   an early response arrives (then stops) or reaches request end. Receiving all
   rejected bytes before replying is not required. Artificially stalling at
   8 MiB+64KiB without any response is not that ordinary scenario; overriding
   response.end is reserved for explicitly labeled cleanup branch controls.
   Clarify the source AC exactly, preserving actual response and bounded rejection
   requirements; this does not waive a transport error or claim every client
   receives a response after cutoff. Reviewer disagreement with this delegated
   contract is recorded, not resolved by changing correct rejection code to
   consume an otherwise refused whole request.

7. The df86c183 full verification failed nine tests in seven files. Five tests in
   three previously unscoped suites call guarded send/ingest without a real tenant
   scope. Add the exact existing data test paths `blobsPerTenant.test.ts`,
   `itemRelationFilter.test.ts` and `mailMessagePreview.test.ts` under
   `backend/packages/data/src/__tests__/` for wrapping those existing production
   calls/fixtures in their correct explicit tenant, preserving their storage,
   pruning, preview and send assertions. Do not weaken scope, role, transaction or
   guard requirements or replace production writes with direct fixtures.

   Add the exact existing `gmailLabelFolders.test.ts` in that same directory to
   reconcile the approved tenant-thread guard with its old independence test.
   The held sync and second same-tenant mailbox reconcile must now serialize;
   prove the second operation's actual PID waits on the exact holder and then
   succeeds after release. A different tenant must still complete before release.
   Preserve the same-mailbox cleanup wait, final folders and rollback assertions;
   cleanup itself keeps only its existing mailbox guard. Use bounded owned pools,
   complete settlement and exact operation PID binding. The old full log's
   advisory statement timeout and status-only assertion do not establish which
   participant timed out, so distinguish that diagnosis from new measured proof.

   This is a test-path/fixture reconciliation of decision1, not a new production
   lock order, migration, permission or mail lifecycle change. The source Task/AC
   and all original handovers remain unchanged. Obtain delta review and a fresh
   complete frozen gate after the repairs. The two unrelated HTTPParserError/SSH
   banner failures passed an isolated unchanged rerun; their cause is unproven and
   neither they nor the MCP inherited-name assertion receive a standing waiver.
