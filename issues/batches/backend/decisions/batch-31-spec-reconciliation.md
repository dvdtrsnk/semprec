# Batch31 specification reconciliation

Parent authority: the owner-delegated backend controller and the accepted local-development continuation ADR. Applies only to this exact batch31 dispatch.

## Durable status and real owners

Migration0087 already constrains assistant lifecycle states to queued/running/done/error. Gh1727 pending references are corrected to queued; pending approval requests remain pending and are never approved by message text. The actual send route owner is semprec-api/sempThreadsHandler.ts. Existing data message/thread owners provide checked transactional operations, not direct service SQL. Existing SempConversation owns freshness and reconstruction; narrowly scoped changes preserve those owners.

## Tick questions and tool grants

The final batch includes gh1731 user questions in tick threads, so gh1620 permits text-only sends to existing tick threads. Context/refs remain rejected there and on item threads. No heartbeat lifecycle/FK change is authorized. Item read-only selection and chat tools remain subject to real grants; registering or selecting an operation never grants page access. Preserve the accepted page-capability exclusion.

## Concrete evidence paths

Per-member Touches explicitly include the actual API handler mappings, exact runtime export catalogs, agent task/envelope/tenant catalogs, agents queue composition harness, real prompt/timezone integration and message read transport tests. Each path retains its member-specific annotation. No package reverse import, private cross-package helper, mocked production owner/dispatcher or production grant expansion is authorized. Provider transport injection remains allowed.

## Unchanged execution controls

One writer; one complete read-only R1 and one same-context focused R2, then parent finite disposition. Full final verify requires a separately pinned parent plan. Previous batch FAIL/NOT RUN, production gates and candidate-local exceptions do not become this batch PASS. Any new lock/recovery/ownership protocol or actual Task/owner contradiction must be traced and grouped for parent adjudication before introducing it; this document does not pre-approve one. Preserve all six original aggregate acceptance criteria and every source Task/AC except the explicit status/tick corrections above.

## Grouped owner seams after intake

- Gh1620 follows [[docs/adr/2026-11-06-inbox-thread-sends-reserve-current-proposals.md]] for current source/card association and nonblocking proposal reservations. SourceInbox edge writers participate through the existing domain-hook owner, covering absent/new associations without trusting nullable thread hints.
- Gh1727 reuses the existing in-flight helper by export, and follows [[docs/adr/2026-11-06-semp-wake-replays-bounded-complete-history.md]] for bounded complete stored reconstruction. Pi0.85.1 publishes low-level names, but its current types differ from the historical adapter; no publication/compaction stub is treated as working integration.
- Gh1732 adds the missing nullable error_code migration and follows [[docs/adr/2026-11-06-semp-recovery-does-not-infer-worker-death.md]]. The former immediate-release latency requirement remains explicitly OPEN/NOT RUN. No lease/heartbeat/PID inference or unsafe unlock is substituted.
- Gh1731 preserves the existing required heartbeat reference and RESTRICT FK. Its impossible deleted-heartbeat fixture is replaced by actual FK refusal plus honest defensive-branch limits, without a lifecycle migration.

All six original outer acceptance criteria remain unchanged. These exact source changes require fresh approvals and regenerated embedded snapshots; they authorize no source staging during the metadata hold.

## Message order and real title accounting

Gh1620/1727 use docs/adr/2026-11-06-semp-message-order-and-session-freshness.md. All three existing message inserters participate; no timestamp tie, UUID inference, new durable sequence or history rewrite is authorized. Gh1769 receives a service-owned real title/client/gateway/accounting test and exactly one workspace devDependency/importer link. Background-only paragraphs are condensed without changing Task/AC decisions. No dependency upgrade or production reverse import is allowed.

## Explicit startup and stop preconditions

Gh1732 follows docs/adr/2026-11-06-agents-startup-requires-a-quiesced-predecessor.md. Single owning agents instance and externally quiesced predecessor are bounded operational preconditions, not a new proven fence. Repository TimeoutStopSec is120s, named margin30s and grace deadline90s from shutdown entry. No running service or host manager is changed by this permission.

## Same-transaction title enqueue owner

Gh1769 may export exactly enqueueSempThreadTitleIfFirst(client, threadId, messageId) from its existing data title owner through the data barrel and exact public-surface catalog. The actual turn handler calls it with the same managed client after a successful done transition. Its checked tenant/thread/message/first-assistant/title guard and queue insertion remain within that transaction; rollback leaves neither done nor its title job. Preserve the literal first-reply selection of Task3/5, unsafe_dedupe, maxAttempts1 and the guarded title job. No extra transaction, provider call, public queue framework or service SQL is authorized.

## Actual Semp settlement at shutdown

This is an implementation of the already accepted stop ADR requirement to settle terminal persistence and retain its failures, not a new queue/liveness protocol. The existing per-process InFlightAgentRuns owner may track actual per-Semp settlement promises and outcomes alongside its existing controllers. Begin observing the shutdown cohort before queue stop; registrations arriving during intake quiescence must also be covered. Retain relevant rejection outcomes until the shutdown owner consumes them, without an unbounded history of successful turns. A fulfilled Runner.stop is not a Semp-persistence witness. Keep the deadline active until the actual Semp work has settled, not merely until Graphile reports stop.

Expected model/task failure whose error state was durably stored is a completed error outcome; failure of that persistence or its cleanup remains a rejection observed independently of Graphile retry handling. Perform ordered cleanup after actual settlements while the pool is still available, then reject shutdown with original failure identities and primary/cleanup ordering intact. Do not filter falsy rejection reasons, swallow the failure into a successful log, change general/non-Semp runner semantics, hold a DB transaction across a provider call, or create a second global registry. Uncooperative work or an expired bound is not proof of settlement or of a stored interrupted marker; report a failed/unsettled outcome and do not claim successful interrupted persistence. Existing stop120/grace90/margin30 and single-owner/quiesced startup conditions remain unchanged.

## Exact title registry gateway-port fixture exception

Only the sempThreadTitle own/foreign/random case in backend/services/semprec-api/src/**tests**/tenantIsolationJobs.test.ts may use a deterministic typed AiGatewayClientPort fixture. This explicit exception overrides the earlier provider-transport-only restriction for that one registry case. Keep the actual API core task registration, enqueueJob/runOnce, data title handler, tenant-scoped runtime-role SQL, guarded title write and post-commit invalidation. Capture trusted tenant and request inputs on the port; own work must complete, while foreign/random identifiers must cause no port call or tenant-visible effect. Keep fixture state isolated and restore it after the case. No fake data owner/dispatcher, reverse service import, shared fixture process, public helper or production dependency is authorized.

This case proves registry composition and data-owner tenant guards, not gateway authentication, accounting or provider isolation. Those remain covered by the separately scoped gateway-service sempThreadTitleComposition.test.ts using the real HTTP client, dispatcher and accounting owners with only provider transport injected. Keep evidence rows distinct; the registry fixture does not satisfy gh1769 accounting AC by itself. No Task/AC requirement or failed historical run is waived.

## Chat-runner quiescence before final Semp settlement

This completes the existing stop ADR ordering; it authorizes no liveness/fencing or unlock protocol. In the existing agents queueRuntime owner, retain a single cached stop attempt for both runners and expose a typed shutdown-specific outcome with each runner's actual fulfilled/rejected status and original unknown rejection reason. A narrow stopForShutdown method over that same cached attempt is permitted; retain stop() rejection semantics for existing callers. Do not stop either runner twice. Schedule each stop independently so a synchronous throw by one does not prevent attempting the other.

The actual shutdown composition uses these outcomes: only fulfilled chat stop establishes no more Semp claims. A general-only stop failure remains logged under the historical policy; it does not become a new fatal general-runner policy. Failed or unknown chat quiescence is fatal even with an empty cohort. Abort existing/late Semp registrations through the existing abort owner, but do not consume/reset its observer as a complete cohort, sweep idle sessions, end a potentially live pool, or log shutdown complete. Preserve the original chat failure and accompanying general/observed Semp/cleanup reasons without filtering falsy values or replacing primary identities. A non-consuming snapshot/disposal of observation in the existing in-flight owner is permitted only to retain observed failures and bounded observer lifetime, never as proof of drain. Pending stop/turn work remains bounded by the existing stop window; timeout is failed/unsettled, not quiescence. Retain failure observers to prevent unhandled late rejections. After successful chat quiescence, actual cohort settlement and ordered cleanup retain the prior decisions.

Use existing shutdown.unit.test.ts lifecycle doubles for chat rejection with an initially empty cohort and late registration, simultaneous failures including falsy reasons, pending stop at the bound, and general-only failure with confirmed chat stop. Keep general behavior unchanged and prove no idle close/pool end/success on unknown chat quiescence. Existing queueRuntime.test.ts may cover real two-runner stop/outcome composition; type-only imports in unit tests must not load Postgres owners. These are lifecycle-control tests, not mocked task/dispatcher evidence. No broader runner factory injection, new public package helper, retry, service process or resource-death claim is authorized.
