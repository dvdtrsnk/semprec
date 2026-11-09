---
status: accepted
date: 2026-11-09
area: [backend]
supersedes: []
superseded-by: null
---

# The page title mirror locks only the children it owns

## Context

[[2026-11-09-page-title-mirror-reserves-the-live-host]] makes the mirror job reserve its live host and then lock the Pages
items its document names, in id order. The job locked every named item before checking its `parentItemId`. A named item can
itself be the host of another job, so two jobs for pages A and B whose documents name each other each held their own host row
and could wait for the other's: an AB/BA wait that PostgreSQL resolves by aborting one transaction.

## Decision

- The lock order stays host, then document, then Pages items in id order. The job now locks only items that, in the unlocked
  read, are live Pages items naming this host as their `parentItemId`. A reference to any other item takes no lock of this job.
- The parent is read again under the row lock, as before, so an item trashed or moved between the read and the lock is skipped.
- No new lock kind, `NOWAIT`, retry or catch is added; an error the database raises still propagates unchanged from the job.

## Premise and limits

- The filter relies on this premise: today the only writer of `parentItemId` is the creation owner (`createSubpage`), which sets
  it on a fresh Pages item under a live parent and refuses an ancestor cycle; trash and restore keep it. Under it a job waits
  only for a child of its own host, so a wait cycle between jobs would need a cycle of `parentItemId` values.
- This is not a claim of freedom from deadlock for stored data that breaks the premise (for example a hand-edited cycle), nor of
  eventual success of a retried job. An owner that later reparents pages must revisit this protocol.
