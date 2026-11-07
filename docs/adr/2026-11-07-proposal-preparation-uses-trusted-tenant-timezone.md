---
status: accepted
date: 2026-11-07
area: [backend]
supersedes: []
superseded-by: null
---

# A proposal preparation receives the tenant time zone as a trusted value from its managed caller

## Context

[[2026-10-31-confirmed-proposal-update-preconditions]] made Inbox update proposals validate through the
read-only preparation registered next to each pre-write transform: a preparation shares the
transform's deterministic checks and normalization, receives no database client, and runs neither
mutation hooks nor allocators. [[2026-11-05-task-proposal-preparation-defers-implicit-completion-day]]
kept the Tasks rules that need the tenant zone and the current day out of preparation by deferring the
one implicit user field they set.

The Events time transform (issue #1598) converts a `date` that carries an offset into the tenant's
wall-clock `date` plus `timeFrom`, and adds the one-hour `timeTo`. All three are user-owned and `date`
is the caller's own field, so its prepared value must equal what the write stores; a deferral cannot
cover a caller field whose value changes. Without the zone the preparation can only refuse such an
update proposal, although the same value written directly is valid.

## Decision

The preparation context gains an optional `timezone`: the tenant's IANA zone as a plain string.
`prepareUserItemPatch` takes it as a required argument and passes it through
`prepareItemPreWriteTransforms` to every preparation of the item's module.

- The managed callers read it: the Inbox step validation (`inboxTickAction.ts`), the computed update
  preparation (`proposalComputedUpdates.ts`) and the locked confirmation check (`proposalSteps.ts`) each
  read it with `getCalendarClock` (`calendarTime.ts`: `getSystemTimezone`, then `assertValidTimezone`)
  in their existing tenant transaction, through the owner's existing settings and default contract,
  when a step has properties to prepare. A settings or database failure propagates; it is not turned
  into a refused proposal.
- A preparation never reads settings and never substitutes a zone. The Events time preparation converts
  an offset `date` with the supplied zone exactly as the write transform does, and refuses it with a 400
  on `date` when no zone was supplied.
- No new transaction, lock or settings snapshot is introduced. The zone is read when a caller prepares;
  confirmation reads it again under the item lock it already holds and repeats preparation, so a zone
  changed between proposal and confirmation yields prepared values that differ from the recorded
  after values and the confirmation is refused without writes. The item lock does not serialize
  settings changes: a change committed after the confirmation's read is not observed by it.
- The Tasks deferral stays as it was; Tasks preparation ignores the zone.

## Consequences

- An otherwise valid Inbox update proposal of an Event whose `date` carries an offset is accepted, with
  before and after values for the converted `date`, `timeFrom` and `timeTo`.
- Every caller of `prepareUserItemPatch` must have a tenant transaction to read the zone in.
