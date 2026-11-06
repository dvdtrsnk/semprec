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
