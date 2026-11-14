---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# `mailThread` cards are produced by the mail module, through the agent tool `mail.thread.proposeTask`

## Context

[[2026-11-14-a-mail-thread-card-proposes-one-task-of-a-thread-and-is-confirmed-as-a-user-write]] adds the card kind
`mailThread` to the table of [[2026-09-23-speaker-mappings-are-edges-proposed-on-transcript-cards]] and leaves its producer
process and production site open for issue gh-2035. That table makes every `kind` of Processing proposals the work of
exactly one producer process, and says that a new producer process or a new production site is a new decision. This is that
decision for `mailThread`.

Semp proposes a task from a mail thread with a tool of the mail module ([[2026-10-28-module-agent-tools-approval-and-grants]]).
The tool has to write into Processing proposals, a database that the mail module does not own, so it is also a handoff of
write access to another owner's data. The alternatives were a Processing proposals tool (that module would then need to know
mail threads and their merge aliases), or a write through the run's agent writer (the capability of the tool is granted with the mail databases, not with Processing proposals, so an agent writer would
need a write grant on a database that the capability does not cover).

## Decision

- **Producer.** The one producer process of `mailThread` cards is the mail module (`mailSync`). Its one production site is
  `proposeThreadTask` in `mail/threadTaskProposals.ts`, called by the agent tool `mail.thread.proposeTask`. The row of the
  table is:

  | `kind`       | Producer process | Production sites                              | Source relation |
  | ------------ | ---------------- | --------------------------------------------- | --------------- |
  | `mailThread` | mail module      | `mail/threadTaskProposals.ts` (agent tool)    | `sourceThread`  |

  Everything else the table's ADRs decide carries over: the producer creates the card through the choke-point package, sets
  only the system keys it needs at creation (`kind`, `proposal`, `aiProposal`, `aiVersion`, `history`, `status`), writes
  the `sourceThread` edge under the Processing proposals `SystemRelationWriteContext`, and never updates or deletes a card
  afterwards; confirm, reject and revise stay with the proposal actions of the Processing proposals module. A `mailThread`
  card created anywhere else is an ownership violation.
- **The write is a system write.** The card and its edge are written as the system writer, as the transcription worker writes
  its cards, because the proposal is the whole of what the agent does and the tool's capability carries no grant on
  Processing proposals. The tool resolves the run, and so its project and user, from the stored run and refuses a run
  without a project, as the other mail tools do; nothing else of the run is recorded on the card, and its first history entry
  has the author `ai`.
- **No approval.** The tool is declared with approval mode `none` and the capability `mail.taskProposal`, which is
  granted to a project that sees the mail databases as `mail.read` is. It creates no task, no `Threads.tasks` edge and
  nothing outside the Inbox; the user's confirm of the card creates the task, so the agent's change is a proposal as
  [[2026-09-10-agent-writes-are-proposals-not-direct-writes]] requires.
- **One open card per name and thread.** The call takes the tenant's mail-thread guard first and then the row lock of the
  thread's Threads item ([[2026-11-13-mail-thread-actions-take-the-thread-guard-before-their-item-locks]]), so a merge of the
  thread and a second call of the tool wait for it. Under the lock it looks for a live card of that thread with the status
  `proposed` whose current envelope names the same task, after trimming and case folding, and returns that card instead of
  creating another. A card that is `confirmed`, `rejected` or in the Trash is not a duplicate. The comparison reads the card's
  own `proposal`, which the user may have edited; the user's edit of a card does not take the guard, so an edit that commits
  after the call's check can make two open cards carry one name, which the user resolves in the Inbox.

## Consequences

- The `inboxPipeline` manifest's ownership handoff names the mail module as the producer of `mailThread` cards.
- A merge of two threads moves the card's `sourceThread` edge to the surviving thread
  ([[2026-11-05-mail-thread-item-merges-transfer-existing-relations]]), so the duplicate rule finds a card of a merged-away
  thread under the surviving thread's item; a call with the id of a merged-away thread proposes for the surviving thread.
- A tenant whose Processing proposals database lacks `sourceThread` (it has not run
  `runThreadTaskProposalCutoverMigration`) makes the tool fail with an error that is not a domain refusal, and writes nothing.
