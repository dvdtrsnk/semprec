---
status: accepted
date: 2026-11-05
area: [backend]
supersedes: []
superseded-by: null
---

# Run item-create transforms after the idempotency reservation

## Context

[[2026-10-29-item-pre-write-transforms-per-module-registry]] places create
transforms before insertItemWithReplay. Its create rule therefore invokes a
transform on a replay and discards the result, requiring deterministic,
side-effect-free transforms. Tasks completion now needs the tenant time zone
and current instant, as required by gh-1544 and
[[2026-11-05-task-proposal-preparation-defers-implicit-completion-day]]. A
committed create could otherwise fail during replay because those inputs
changed, before reaching the existing replay owner.

The item store already accepts resolveCreateProperties, invoked only after
its reservation has ruled out a live replay and before the new item insert.
Defaults already use that callback. Reusing it avoids a second lookup or a
Tasks-specific branch in the generic write owner.

## Decision

This narrows only the create execution point in the registry ADR. Preserve
its accepted body and its other rules. Move the existing generic create
transform invocation inside the existing resolveCreateProperties callback,
before the existing default expansion and final value validation. Preserve
transform registration order, context, writer identity, ownership validation
and the exact transformed properties passed to the insert and create hooks.
No new callback, store writer, transaction, lock or reservation query is added.

Keep existing database/tenant/archive/replay guards and caller property
permission and color validation in their existing order before the store call.
This does not promise to bypass invalid caller input or authorization on a
replay. Once the existing store identifies a live committed replay, it returns
that item without invoking the create transform, defaults, create hooks,
heartbeat enqueue or create invalidation again. A fresh create invokes the
transform once in the caller's managed transaction, including a fresh create
that replaces a stale reservation under existing store semantics.

A failed fresh transform rolls back its reservation and any transactional
work with the existing managed write. No external service or out-of-transaction
side effect is permitted in a transform. Update transforms and read-only
proposal preparation are unchanged; Tasks day and instant calculation stays
in the module transform, never the generic owner.

## Consequences

Module transforms no longer need replay-time determinism: they can use the
transactional inputs their approved feature requires without re-executing
on an already committed create. Repeated request payloads still undergo the
existing caller guards; the original stored item remains the replay result.

Regression evidence must prove that replay does not call the transform,
that the original item/completion values and side-effect counts remain
unchanged when relevant time/settings inputs change, and that failed fresh
creation leaves no new item, durable reservation or transactional side
effects. Keep fresh-create transform ownership/validation, concurrent replay
and existing default behavior checks. This decision does not weaken an
assertion merely to hide an earlier failure or alter generic input policy.
