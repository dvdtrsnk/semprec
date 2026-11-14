---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# An organizer's update is adopted into an Event's fields by the calendar module until the user changes the field

## Context

Answering an invitation with `accepted` or `tentative` creates an Event from the invitation's title,
place and times (issue gh-1944). Those Events properties are user-owned: `name`, `place`,
`date`, `timeFrom`, `timeTo` and `endDate` of the Events database are written by the user through
the generic item routes. When the organizer later moves or renames the meeting, the iMIP `REQUEST`
arrives as a new email with the same `UID` and a higher `SEQUENCE`, and the user's calendar has to
follow without losing what the user changed (issue gh-2007).

[[2026-09-10-single-writer-ownership-model]] wants one writer for each piece of state and an explicit
handoff, recorded in the module contract, wherever a second writer is needed. Inbound mail is now a
second writer of those six Event fields: the heartbeat action `calendar.ingestInvitation` writes them
while no user is present. Writing through the choke point
([[2026-09-10-choke-point-api-for-state-writes]]) does not change who the writer is.

Alternatives that were rejected: never touching the Event after the answer (the user's calendar goes
stale and the invitation and the Event disagree), always overwriting it (a user's own rename or move is
lost silently), and storing a copy of every adopted value beside the Event so that "changed by the
user" can be read off a flag (a second copy of the state that has to be kept in step).

## Decision

**The handoff.** The calendar module's invitation ingest is the only non-user writer of `name`, `place`,
`date`, `timeFrom`, `timeTo` and `endDate` of an Event that an answered invitation links through its
`event` relation. The handoff is recorded in the header comment of
`backend/packages/data/src/calendar/calendarModuleManifest.ts`. It writes with the system writer kind
(`updateItemWithClient` names no writer) and only inside the transaction of the email that carries the
update, under the same per-tenant and `UID` advisory lock as the invitation's creation and cancellation.

**Adopted until the user's first change, decided per field and without a stored copy.** A field is
written only when the Event's stored value equals the value the invitation's previous fields produce
through `invitationEventFields`, the one pure mapping the respond route also uses, and the new fields
produce another value. Both values are put through the Events own time rules first
(`deriveEventTimeProperties`), so that a default end the Events write supplied compares equal. A field
the user changed no longer equals the previous mapping and is left as stored; the rest of the same
update is still written. The comparison is made on the Event row, locked `FOR UPDATE`, in the same
transaction as the write. A trashed Event (after `declined`, or trashed by the user) and a missing
one are not touched; the invitation still takes the new fields.

**Absence clears, except for the title.** When the new fields produce no value for `place`, `timeTo` or
`endDate`, and the Event still holds the previous one, the field is cleared (`null`). `name` is never
cleared and never set blank: an update that carries no usable SUMMARY leaves the Event's title as it is,
because the system writer is not held to the non-blank title rule that every user write is
(`assertTitlePresent`), so nothing else would refuse a null title.

**Only the organizer may update.** An update of an answered invitation is applied only when the message's
sender (`envelope.from`) equals the invitation's stored `organizerEmail`, compared without regard to
case, the comparison a cancellation already makes. Any other sender changes nothing and is logged with the
email and invitation ids and the reason code `sender_not_organizer`. Without it any sender who knows a
`UID` could move the user's Event and replace the stored organizer address. A pending invitation's update
is not covered by this decision; it belongs to issue gh-1929.

**A refused Event write rolls the whole email back.** When the Events rules refuse the patch (for example
the user moved the end and the organizer moves the start past it), the failure is logged with the ids and
the reason code `event_validation_failed` and rethrown. The invitation, its `sourceEmail` edge and the
Event are written in one transaction, so none of them changes and the heartbeat action fails. The
alternative, skipping the Event and keeping the invitation's new fields, would leave the invitation and
the Event disagreeing with no record.

## Consequences

- A user who changed a field keeps it for good: the stored value no longer equals any mapping the
  invitation produced before, so later updates leave it too, until the invitation's mapping happens to
  equal it again.
- An update that drops the title leaves the invitation without a title while the Event keeps its own.
  The Event's `name` then no longer equals the invitation's previous mapping, so a later update that
  brings a title back does not write it.
- No notification is written and nothing is sent for an update.
- A refused Event write fails the heartbeat action on every run for that email until the data
  changes; the failure is visible in the log by its reason code.
- A calendar client that sends updates from an address other than the organizer's (a delegate or an
  assistant) is not applied; the sender check trades that for not accepting an update from anyone.
