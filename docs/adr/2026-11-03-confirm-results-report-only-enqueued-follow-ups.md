---
status: accepted
date: 2026-11-03
area: [backend]
supersedes: []
superseded-by: null
---

# Confirmation results report only actually enqueued follow-ups

## Context

Gh-1648 introduces persisted per-step confirmation results with a `followUp`
discriminator. Current confirmation branches do not enqueue transcription or MCP
sync. The standalone Files heartbeat is a later transaction and deliberately
skips Inbox-origin files. Planned gh-1978 owns consented recording-card intake and
its transcription enqueues; planned gh-1976 owns MCP-server confirmation sync.
Inferring queued work from a MIME type or database would report a job that does
not exist. Implementing either producer early would bypass its specified intake,
consent, credential and validation contract.

## Decision

Gh-1648 supplies the result structure, accurate executed-step mapping, storage,
response and idempotent replay. Every current confirmation path that enqueues no
such job records `followUp: null`. A heartbeat job is not a transcription enqueue.
The two explicit non-null discriminators remain part of the declared contract,
not evidence that their future producers already exist.

The actual enqueue and non-null result obligation is assigned explicitly to its
owning issues: gh-1978 for `transcriptionQueued` and gh-1976 for `mcpSyncQueued`.
Both consume gh-1648 and set the matching persisted step result only after their
real enqueue helper succeeds, in the same caller-owned confirmation transaction.
The enqueue, result, card state and created resources roll back together. An
already-confirmed replay returns its stored result unchanged and enqueues nothing.
Do not add a public callback, test hook or second producer to fabricate this proof.

This is a staged ownership split under
[[2026-09-10-side-effects-follow-the-commit]], not permission to drop a requirement.
The precise queue/result tests remain in the updated owning issue specifications
and their future aggregate snapshots. Their execution stays NOT RUN until those
issues are implemented and verified. Existing transcription worker ownership and
recording-intake rules are unchanged.

## Consequences

Current local confirmation results can truthfully ship before the two producers.
No audio is transcribed merely to populate a result flag, and no MCP connection
runs inside confirmation. Future workers must establish actual committed jobs,
matching result entries, rollback and replay through the real confirmation path.
A passing gh-1648 null-branch test is not proof of either future producer.
