---
status: accepted
date: 2026-09-19
area: [backend]
supersedes: []
superseded-by: null
---

# Derived system-owned properties are computed inline in the choke-point, keyed by module ownership

## Context

Issue #193 requires Tasks' `time` property to be a read-only value
automatically derived from `timeFrom`/`timeTo` on every create and update,
regardless of caller — the web client, an agent proposal once confirmed, a
future import path. `time` is declared `owner:'system', locked:true`
(`seedTenDatabases.ts`), so `assertWritableProperties` already rejects any
caller that tries to set it directly.

The existing `allowedSystemKeys` escape hatch (`journal/journalStore.ts`,
issue #25) looks similar at first glance — it also interacts with the
`owner:'system'` rejection in `assertWritableProperties` — but it solves a
different problem: it *lifts the rejection* for one specific, trusted caller
that already computed the value itself (Journal's lazy item creation passing
`name`/`type`/`period` it derived before calling in). It never computes
anything on the choke-point's behalf; the value still has to arrive as an
ordinary property on the caller's input.

Tasks' `time` cannot be built that way: no caller should ever need to know it
has to derive and pass `time` alongside `timeFrom`/`timeTo`. Requiring that
would leak the derivation into every present and future write path (the
Tasks UI form, an agent proposal's confirm step, a CSV import) and
reintroduce exactly the drift that making `time` `owner:'system'` exists to
prevent in the first place.

## Decision

`createItemWithClient` and `updateItemWithClient` compute `time` themselves,
inline, gated by `database.ownerModuleId === TASKS_MODULE_ID`, after
`assertWritableProperties` has already rejected any caller-supplied `time`:

- On create, `deriveTaskTime(timeFrom, timeTo)` runs against the incoming
  properties and the result is merged into the row before insert.
- On update, when the patch touches `timeFrom` or `timeTo`, the current row
  is locked (`itemsStore.lockItemById`) to read whichever of the pair isn't
  in the patch, and `time` is recomputed from the effective pair before the
  properties patch is applied.

This is a distinct pattern from `allowedSystemKeys`: it relaxes no
permission check, and it applies unconditionally to every write against the
owning module's database rather than being opted into per call site. Module
identity (`ownerModuleId`) is the key, not a caller-supplied option, because
the derivation has to run no matter who is writing.

## Consequences

- Every write path that touches Tasks' `timeFrom`/`timeTo` gets `time` for
  free; no caller, present or future, needs to know the derivation exists.
- A future module needing the same shape — an unconditional, ownership-keyed
  derived property — follows this inline-in-choke-point pattern rather than
  reaching for `allowedSystemKeys`, which stays reserved for permission
  delegation to one specific trusted caller.
- The generic create/update path now carries one module-specific branch per
  function. Two branches for one module isn't yet a pattern that needs
  further generality; if a third derived property is added for another
  module, extracting a small per-module hook table becomes worth revisiting.
