# Decision: merge sequences 40-74 into one parallel program

## Question

Batches 1-39 are delivered. The owner asked on 2026-11-10 to merge all
remaining batches into one program and implement it in parallel instead of
one batch after another, keeping the project's rules, quality, security and
tests. How are the records and the manifest changed so that this is true
without falsifying history or approvals?

## Options considered

- Keep the 35 proposed aggregates and run them one at a time: rejected by the
  owner's instruction.
- Edit the `Blocked by` lines of the sources to drop shared-file ordering:
  rejected. It would invalidate 305 approvals and remove ordering that the
  merge still needs.
- One new aggregate record that embeds every source: impossible under the
  60,000-character specification limit.
- Keep every source record as approved, withdraw the aggregates, and let the
  queue treat shared-file ordering as landing order: chosen.

## Decision

Recorded in
`docs/adr/2026-11-10-parallel-backend-delivery-through-a-serialized-merge-queue.md`,
which supersedes `2026-10-31-sequential-backend-delivery-batches`.

Exact changes made with this decision:

- `manifest.json`: status `merged` on the 35 entries of sequences 40-74
  (sequence, hashes and members unchanged); a `parallelProgram` pointer to
  the decision, the integration branch and its base; `sourceCount` 669 to 670.
- `verify.mjs`: accepts status `merged`. A merged batch keeps the sequence,
  routing, hash, dispatch-suppression and dependency-order checks. It is not
  required to embed its members' snapshots. `verify.test.mjs` covers this.
- The 35 aggregate records of sequences 40-74: state `closed`, reason
  `not_planned`. Title, body, parent, labels and approval (none) are
  unchanged. They were never approved and are never completed.
- New record `sp-0ef30642-7659-4424-9527-180d99a33ae9`, "Split the route
  matrix into per-area slice modules": the route matrix has 16 counted lines
  left under the 900-line lint cap and the remaining sources add about 94
  entries. Approved, labeled as a program source, first member of sequence 40.
- gh-1364: completed with its existing handover. Its work, the ADR
  `2026-10-29-calendars-are-not-shared-between-tenants`, is in the base;
  the resolution commit is the base commit `745aea3f`, because the original
  commit `1527d7cd` is not an ancestor of the squashed base.
- Sources of sequences 1-39, gh-1086, the two held client records and their
  aggregates: unchanged.

Not done by this decision: gh-1783 remains unapproved. The correction in
`issues/decisions/gh-1783.md` is re-applied and approved before that source
is dispatched.

## Authority

Owner instruction in BB thread `thr_hc2df5gf4u` on 2026-11-10: approval of
the parallel plan, of replacing the sequential decision, of six concurrent
chains of up to four sources, of a full integration tier run after every
eight landed chains, and of pushing the integration branch with a draft pull
request at checkpoints. Recorded by the controller of that thread, model
Claude Fable 5.2.

## Addition of 2026-11-10: purge hook preparation source

gh-1691 ("Purge mail rows when an email item is purged") was stopped at its
worker's preflight. Its Task registers a mail purge hook and names #1601 as
the deliverer of the purge hook registry, with the registry itself out of
scope. gh-1601 was corrected before approval to exclude purge hooks, and
`docs/adr/2026-11-07-item-delete-and-restore-domain-hooks.md` leaves them
undecided. No record delivered the registry.

Options: correct gh-1691 so that it also delivers the registry and its ADR
(rejected: two mechanisms in one source and a new approval of an approved
text), import the mail stores into `itemTrash.ts` (rejected: the accepted
boundary rule refuses further domain imports there), or add one preparation
source (chosen).

New record `sp-962cf217-c004-462b-941b-702f5d7536b8`, "Run item purge hooks
inside the permanent purge": approved under the owner's delegation recorded in
`docs/adr/2026-10-31-owner-delegated-backend-program-supervision.md`, labeled
as a program source, second member of sequence 40. `manifest.json` `sourceCount`
670 to 671. gh-1691 is unchanged; the controller starts it only after the new
source has landed. Actor: controller of BB thread `thr_hc2df5gf4u`, model
Claude Fable 5.2.

## Addition of 2026-11-11: gh-1783 correction re-applied

The correction of gh-1783 recorded in `issues/decisions/gh-1783.md` (migration
limited to DDL, the reindex helper with a cursor, the three writers of message
text, the Hunspell harness, blockers #1620 and #1727) was approved on
2026-10-29 and lost when the sequential batches were planned. Its six recorded
line changes were applied again unchanged to the current record, which keeps
the backend-only scope section added since. The record is approved again for
its new hash, and its manifest member carries the new hash and the four
blockers. Both added blockers are completed. Actor: claude-delegated-by-david,
controller of BB thread `thr_hc2df5gf4u`, model Claude Fable 5.2.
