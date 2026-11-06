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
