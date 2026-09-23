---
status: superseded
date: 2026-09-23
area: [backend]
supersedes: []
superseded-by: 2026-09-23-speaker-mappings-are-edges-proposed-on-transcript-cards
---

# Processing proposals: each `kind` has exactly one card-creating producer

## Context

[[2026-09-10-single-writer-ownership-model]] gives every field one owning process and requires a
second writer to be an explicit handoff recorded in the module contract. Processing proposals is
declared by the `inboxPipeline` manifest, and until issue #247 only the Inbox pipeline's
`semprec.tick` created cards (`kind = 'inbox'`, linked through `sourceInbox`). The schema already
anticipated a second source: `kind` allows `'transcript'` and `sourceTranscript` targets
Transcripts. Issue #247 has the transcription pipeline's match step emit a `kind = 'transcript'`
card, which [[2026-09-23-transcription-worker-writes-event-match-results]] lets
`semprec-transcribe` write in-process. That makes Processing proposals a sink with two producers,
and nothing yet said whether that is allowed or how writes are divided between them.

The alternative was to keep the Inbox pipeline the only creator: the transcription worker would
enqueue a job and the Inbox pipeline would create the card. That splits the match's checkpoint
read and its outcome write across two transactions and two processes, which is exactly what the
row-locked, idempotent match step exists to avoid, and it puts transcript-specific logic in a
module that has no other reason to know about Transcripts.

## Decision

Processing proposals is a multi-producer queue partitioned by `kind`. Each `kind` has exactly one
producer, and only that producer creates cards of that kind:

| `kind`       | Producer                                               | Source relation    |
|--------------|--------------------------------------------------------|--------------------|
| `inbox`      | Inbox pipeline, `semprec.tick` (`inboxTickAction.ts`)  | `sourceInbox`      |
| `transcript` | `semprec-transcribe`, match step (`transcriptEventMatch.ts`) | `sourceTranscript` |

A producer creates its cards through the choke-point package, sets only the system keys it needs
at creation (`kind`, `proposal`, `history`, `status`, and for `inbox` also `fingerprint`), and
writes its source relation under the Processing proposals' `SystemRelationWriteContext`. It
never updates or deletes a card of another kind. Once a card exists, what happens to it after
creation — `confirm`, `reject`, `revise`, and the `resultItemId`/`resultLabel` those write —
stays with the Processing proposals module's proposal actions, whatever the card's kind. The
`inbox` producer's recompute of its own unlocked cards is unchanged.

The `inboxPipeline` manifest records this table as its ownership handoff. Adding a new `kind`,
or a second producer for an existing one, is a new decision.

## Consequences

- Card ownership stays traceable per kind: a `transcript` card written by anything other than
  the match step, or an `inbox` card by anything other than `semprec.tick`, is an ownership
  violation.
- The confirm/reject/revise path has one owner for all kinds, so issue #184's transcript-card
  confirm extends that path rather than adding a second one.
- The Processing proposals schema stays shared, so a producer that needs a new property or
  status value has to change the shared schema, and the other producer's behavior with it has
  to be checked.
