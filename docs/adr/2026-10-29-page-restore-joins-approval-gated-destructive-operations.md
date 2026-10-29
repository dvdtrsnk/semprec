---
status: accepted
date: 2026-10-29
area: [backend]
supersedes: []
superseded-by: null
---

# Page restore is the sixth approval-gated destructive operation

## Context

[[2026-09-18-non-destructive-generic-operations-bypass-agent-approval]] lists five destructive
generic operations, which are the only ones an agent call queues for approval: "those five, and
only those five". [[2026-09-18-exactly-once-execution-of-approved-destructive-operations]] defines
how an approved request is executed: a `resource_snapshot` is taken when the request is created,
and the replay recomputes it and terminalizes the request as `conflict` when it differs.

[[2026-10-28-page-operation-family]] classifies `page.restoreVersion` as destructive, and
[[2026-10-29-agent-page-write-policy]] keeps it behind approval. That family gives the operation the
capability `core.page.write`, which the first implementing issue (#1615) adds to the catalog. Issue
#1617 implements `page.restoreVersion` before that capability exists.

Neither accepted ADR covers a sixth operation, so this record adds it. Their bodies are unchanged.

## Decision

1. `page.restoreVersion` is destructive in the sense of `OPERATION_METADATA`: `requiresApproval`
   is `true`, `riskClass` is `destructive`, and `reversible` is `true`, because a second restore to
   an earlier instant undoes it while the history is retained. The operation is therefore a
   sixth member of the destructive set, and an agent call is queued for approval like the other
   five.
2. Its capability is `core.item.write`, not `core.page.write`. This carves an exception into
   section 3 of [[2026-10-28-page-operation-family]] for this one operation only, until #1615
   adds `core.page.write`. A follow-up decision will say whether the operation moves to that
   capability. The other page operations of the family keep their own capability.
3. The approval snapshot is computed by the docs module (`computePageRestoreProjection` in
   `packages/data/src/docs/docPageRestore.ts`), because `chokePoint/` may not import `docs/`. It
   contains the document id, the item id, and the document's `lastEditedAt` and `lastEditedBy`, and
   it is hashed with the same `buildResourceSnapshot` as the five existing kinds. Before a request
   is created, the preflight refuses an unknown, trashed or non-page item (404), a future `at`
   (400), and an `at` outside the retained window (410). A refused call creates no approval
   request.
4. The replay recomputes the projection inside its transaction. The projection takes the document
   lock (the `doc_snapshots` row, the one every content update takes first) before it reads
   `lastEditedAt`, and the restore then runs in the same transaction under that lock. An edit
   committed after the request was created therefore changes `lastEditedAt`, and the replay ends
   as `conflict` without restoring anything. An edit cannot commit between the replay's check and
   its restore, because every content update is appended by `mutateDocWithClient`, which takes the
   same lock before it appends.
5. The lock order of the replay is: the approval request row, then the `agent_run` row, then the
   document lock. The preflight takes the document lock inside its own transaction, before it
   inserts the request.
6. The approval description is `approval.pageRestore` with `itemName`, `databaseKey` and
   `databaseName`. The instant is an argument value, and the description never carries argument
   values, so `at` is left out, as in the rest of the approval descriptions.

## Why

The approval gate is the mechanism that keeps an agent's destructive changes behind a human
decision. [[2026-09-10-agent-writes-are-proposals-not-direct-writes]] requires it. Routing the
restore through a non-destructive path would let an agent replace a page's content without
approval. The restore is destructive in effect, since it discards the current content. A separate
approval mechanism would be a second system for one operation, which is more than this decision
needs.

The capability carve-out is accepted because `core.page.write` does not exist yet. Until it does,
the choice is either `core.item.write`, which this record takes, or no grant at all for the
operation. A grant of `core.item.write` allows an agent to request a restore, but the request
still waits for a human decision. A REST session is not gated (see the existing rule for destructive
operations over REST), so a user restores directly.

## Consequences

- The comments that count the destructive operations (`capabilities.ts` and the gateway) say six,
  and `destructiveProjection.ts` no longer states a count. The five-operation list in the two
  accepted ADRs above stays as a historical record.
- `ResourceSnapshotKind` gains `page_restore`. No migration is needed, because
  `approval_requests.resource_snapshot` has no kind constraint.
- The web approval catalog gains `approval.pageRestore` in English and Czech.
- The page-family ADR's capability for `page.restoreVersion` is replaced by this record until #1615
  adds `core.page.write`. A later decision that moves the operation must be a new ADR.
