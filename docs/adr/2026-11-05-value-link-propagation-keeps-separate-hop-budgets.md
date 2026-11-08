---
status: accepted
date: 2026-11-05
area: [backend]
supersedes: []
superseded-by: null
---

# Value-link propagation keeps separate hop budgets

## Context

Hook WriterIdentity has no propagation depth. Graphile replace overwrites a
pending payload; unsafe_dedupe can discard a fresh running-job successor.
There is no supported minimum-depth payload merge in enqueueJob. Separating
keys by depth alone also loses shallow fanout when a deeper job writes first
and the shallow recomputation is a no-op. This narrows gh1593's original key
and chaining clauses, preserving its value-write/no-invalidation no-op rule.

## Decision

Use a domain-local AsyncLocalStorage.run context, bound to the exact client and
valueLinks operation, around inherited writes. Ordinary external changes start
a new budget; hooks use that context only for matching client/system writes.
Do not alter generic WriterIdentity, hook interfaces or tenant scope. Never use
enterWith or a mutable global depth counter.

Count the immediate via-edge copy as hop1. Execute at most hops1..5; downstream
enqueues increment the hop, and a dropped hop6 is logged once per dropped
scheduling attempt without item contents. Queue keys include ruleKey,
sourceItemId and hop; tenant namespacing remains the existing queue envelope.
Use normal replace within the same budget. Do not add Graphile-private writes,
a generic merge mode, advisory locks or a durable propagation protocol.

After a live still-on target is resolved under the required recheck, schedule
its relevant downstream rules with the remaining budget even if its effective
value already matches. This is domain scheduling, not a fabricated changed-hook
call. An unchanged target gets no value write or invalidation. This preserves
shallow work after deeper-first completion; each initiating budget terminates
at5. No-op idempotency concerns values/link state/invalidations, not absence of
bounded downstream queue work.

Read pages by link id with existing bounded committed batches. Within a batch,
reserve target items in stable UUID order before their link rows; recheck on
state and live schema/item ownership after reservation before valueLinks writes.
Do not take link before the item writer's existing item-before-link order.
Keep existing relation admission and domain guards, atomic queue scheduling and
after-commit invalidations. No global multi-item deadlock guarantee or remapping
of arbitrary SQL errors follows.

## Consequences

Use only the domain catalog/hooks/propagation owner and a small internal context
leaf. Test interleaved root and inherited work, two simultaneous tenants/clients,
shallow/deep enqueue orders and deeper-first completion followed by shallow
no-op, exact five/six-hop boundary, same-budget collapse/running successor,
user break races and item/link rollback. Broken/deleted targets do not acquire
new writes. Wider generic hook/queue changes and a minimum-depth merge protocol
were rejected as unnecessary for this bounded contract.
