---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# A recording card claims a transcription follow-up only for the jobs it enqueued

## Context

[[2026-11-03-confirm-results-report-only-enqueued-follow-ups]] says a confirmation result reports a follow-up only for
work the confirmation really enqueued. [[2026-11-14-inbox-recording-cards-confirm-into-recording-intake]] implemented
`transcriptionQueued` by reading both jobs back after the recording intake, so a confirm that merely found the jobs
queued under their keys also recorded the follow-up. That happens when the card's audio is already a live Files item
that names the same blob and whose upload, or an earlier intake, queued the transcription.
[[2026-10-25-undoing-a-confirmed-proposal-reverses-its-recorded-writes]] cancels, on undo, the jobs "started by a
confirmation", and it finds them through the recorded `followUp`. For a reused Files item that cancelled the jobs of the
user's own upload, which stays in Files and which nothing queues again.

## Decision

`transcriptionQueued` is recorded only when the intake of the confirm added a `transcriptionCreate` or a
`transcriptionJob` itself (`recordRecordingIntake` returns `enqueued`). A confirm that finds both jobs already queued
records no follow-up and the undo of its card touches no job. The confirm still reads both jobs back and fails when one
is missing, so it never succeeds without a transcription in progress for a Files item that has no transcript.

This narrows the **Result** paragraph of the recording-cards ADR, which said the follow-up is recorded when the confirm
read both jobs back; everything else in that ADR stands.

The undo of a card whose follow-up is `transcriptionQueued` locks the Files row before it removes the jobs. Every
producer of these jobs (the intake, the upload, a rerun) holds the Files row when its enqueue upserts the job rows, so
the undo takes file then job rows in the same order and cannot deadlock with one of them.

## Consequences

The undo cancels exactly what its confirmation queued. A card that reused a Files item whose transcription was already
queued shows no queued transcription in its results, although one is in progress, because the confirm did not start it.
A partial case, one job found and the other added, records the follow-up, and the undo removes both jobs of the file.
