---
status: accepted
date: 2026-10-29
area: [backend]
supersedes: [2026-09-19-derived-system-properties-computed-inline-at-choke-point]
superseded-by: null
---

# Item pre-write transforms are registered per owning module at the choke point

## Context

[[2026-09-19-derived-system-properties-computed-inline-at-choke-point]] computes Tasks' derived `time` inside `createItemWithClient` and `updateItemWithClient`, behind a branch keyed on `database.ownerModuleId === TASKS_MODULE_ID`. [[2026-09-30-choke-point-domain-hooks-through-a-per-process-registry]] moved every domain's transactional side effect out of `chokePoint/` into per-process registries, but those registries run after the row is written and return nothing. The choke point could reject a write, never change one. The only pre-write transformation that existed therefore stayed in `itemWrites.ts`, and the 2026-09-30 ADR carved `tasks/` out for it.

Several planned features need a pre-write transformation owned by one module: normalizing Events times, validating Tasks titles and dates, recording a task's completion day, and recurring-series identity. Each would add another module branch to `itemWrites.ts`.

This ADR extends the mechanism of [[2026-09-30-choke-point-domain-hooks-through-a-per-process-registry]] to pre-write transforms. It amends that ADR's `tasks/` exception: the `deriveTaskTime` derivation no longer lives in `itemWrites.ts`. It is now a Tasks-owned transform in `tasks/tasksItemPreWriteTransform.ts`, registered in `domainWriteHooks.ts`. The 2026-09-30 ADR is accepted and not superseded, so its text is unchanged.

## Decision

`chokePoint/hooks.ts` has a registry of pre-write transforms:

- `registerItemPreWriteTransform(moduleId, transform)` attaches a transform to an owning module id. Registering the same `(moduleId, transform)` twice is a no-op.
- `hasItemPreWriteTransform(moduleId)` reports whether the module has any transform.
- `runItemPreWriteTransforms(moduleId, context)` runs the module's transforms sequentially in registration order, each receiving the previous output, and returns the final patch. It throws on the first rejection.

A transform receives `{ client, database, stored, patch, humanWriterUserId, writer }`. `stored` is the locked current row on update and `null` on create. It returns the properties to store, or throws. A `ValidationError` surfaces as `400 validation_failed`.

The contract is:

1. **Scope.** A transform runs only for a database whose `ownerModuleId` equals the id it was registered under.
2. **Create.** The transforms run after the caller's properties pass `assertWritableProperties` and before `insertItemWithReplay`. The transformed properties are the ones inserted and passed to the create hooks. The idempotency check happens inside `insertItemWithReplay`, after the transforms have run. On a replay, the transform output is discarded and nothing is written. The transforms therefore run on a replayed call too, so they must be deterministic and free of side effects.
3. **Update.** When the database's module has at least one transform, the item row is locked with `lockItemById` (`SELECT ... FOR UPDATE`) before the transforms run. A missing or trashed row is a `NotFoundError`. Until this transaction ends, no other write can change the `stored` row that the transforms read. A database whose module has no transform takes no extra lock. The transformed patch is what `updateItemProperties`, the update hooks, the value-link break, the rollup dependency loop and the timezone check receive.
4. **Ownership of added keys.** The rule covers keys that the transform adds, meaning keys absent from the caller's patch. Such a key must exist on the database, or the write fails with `ValidationError`. It must not be a `rollup` (`403 computed_readonly`) or a `relation` (`ValidationError`). If it is `owner: 'system'`, its `ownerProcess` must be `null` or equal the transform's `moduleId`. Otherwise the write fails with `403 owner_violation`. A `null` `ownerProcess` is allowed because the seeded derived keys (Tasks `time`, Events `time`) declare no process and the owning module is their only writer. Some seeded system keys name a module id as `ownerProcess` (for example Emails' keys in `seedEmailModule.ts`). Rule 4 accepts such a key only for a transform of that same module. A declared process name such as `transcribe` or `valueLinks` is a violation for every transform. Keys the caller sent keep the `assertWritableProperties` result.
5. **Tasks is the first transform.** On create it always stores `time`, computed from the incoming pair. On update it stores `time` only when the patch names `timeFrom` or `timeTo`, computed from the patch merged over `stored`.

## Consequences

- Every Tasks update now takes the item row lock, where before only an update naming `timeFrom` or `timeTo` did. The stored values are unchanged. Concurrent Tasks updates to one item now queue on that row.
- `updateItemWithClient`'s returned `previous` still lists only the caller's keys. A key that a transform added does not appear in it. A transform that leaves out a key the caller sent does not write that key.
- Rule 4 covers `owner: 'system'` keys only. A transform may add a key with `owner: 'user'` without a check. The value-link handoff check (`assertValueLinkHandoff`) runs on the caller's keys only, so a transform-added user-owned key bypasses it. A module that adds user-owned keys must account for that itself.
- The registry names no domain. A module is identified only by the id it registers under. `itemWrites.ts` no longer names Tasks or the `deriveTaskTime` derivation. It still names Transcripts, which `assertTitlePresent` exempts from the title rule. Moving that exemption is outside this decision.
- A transform runs inside the caller's transaction, so a `ValidationError` rolls the whole write back. A transform must not call slow external services, because it would hold the row lock and a pooled connection while it waits (`state-writes` §4).
- A module that needs a pre-write transform registers one in its own file and adds one line to `domainWriteHooks.ts`. It does not edit `itemWrites.ts`.
