---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# Transcript segment refs resolve in batches and are labelled by display name

## Context

[[2026-11-06-semp-reference-reads-stay-in-data-owners]] says the history label reader performs at most one resolver statement per nonempty kind for the returned page, and that the label of an item, block or transcriptSegment ref is the item's title property. [[2026-11-06-semp-refs-validate-observed-tenant-state]] says refs are validated in batches by kind. Issue 1834 adds a decision those two sentences do not cover: the label of a `transcriptSegment` ref is the transcript's display name with the stretch ("Client meeting 5:12-6:30"), and a ref is valid only when its range passes the limits of `transcript.segment.get`, which needs the stored segments of the transcript. The title property of a Transcripts item is not that name: the display name is the user's `name`, else the name of the live linked Event, else "Recording D. M. HH:MM" from the recording date, in the tenant's time zone and language.

## Decision

This narrows the two decisions above for the `transcriptSegment` kind only; every other kind, and the batching rule itself, stay as they are.

- Label: for `transcriptSegment` the history keeps the state and the database key of the generic statement, and replaces the label with the display name of the current transcript plus the stretch (`m:ss-m:ss`, `h:mm:ss` from one hour on, fractions cut off). The display name is the one of issue 1830, composed in memory by `resolveTranscriptDisplayName`. A transcript in the Trash is labelled exactly like a live one, with its live Event, so a trash and a restore do not rename the ref. A trashed Event counts as no Event. An item that is no transcript keeps the generic label.
- Batching: the label of a history page is read for all of its segment refs by one statement over the distinct item ids (name, date, first live Event name) plus one statement each for the tenant's language and time zone, however many refs and transcripts the page holds. It never composes the transcript detail and never reads segments, speakers or notes. The statement count does not grow with the number of refs.
- Validation: the segments of every transcript named by the segment refs of a message are read by one statement over the distinct item ids (the "transcript/database qualification" of the validation ADR, now also returning the stored segments once per transcript). Each ref is then decided in memory by `validateTranscriptSegmentRef`, with the limits of `transcript.segment.get`. A ref whose numbers cannot name a stretch is refused without a read.
- Turn expansion is not batched: it reads one ref at a time through the detail composition, as the per-ref unavailable contract of the reads ADR already has it, and its trashed branch takes the display name from the same reader as the label.

## Consequences

An item or block label stays the title property; only this kind differs, and a reader of the reads ADR must take this one with it. The segments of a long transcript are read once per distinct transcript per send, not once per ref. The first live Event of a transcript is the lowest relation id, which matches `readTranscriptDetail` for the single Event a transcript carries. Tests prove the statement counts for validation, labels and a history page of many segment refs, and the label of a trashed, restored and Event-named transcript.
