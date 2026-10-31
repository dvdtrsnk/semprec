# Autonomous backend program controller

Owner: parent BB thread `thr_pz39tcih5r`. Standing instruction: process the entire
main sequence autonomously, including project decisions and batch 19. Scope is
backend only, one shared working tree, local integration into
`feature/backend-delivery`; do not merge into develop, push or deploy.

Use the scoped authority in
`docs/adr/2026-10-31-owner-delegated-backend-program-supervision.md`.

## Dispatch

1. Confirm the previous worker is finished, its batch and all approved members
   are completed with handovers, and the accepted candidate is in the clean
   integration branch. Reconcile existing implementations rather than rebuilding
   them. Never start another writer concurrently.
2. Archive the previous batch worker, verify archival, then create the next
   worker. The parent remains active and owns the shared environment. Do not use
   end-thread or delete the environment/working tree during this process.
3. Approve the exact current aggregate and any unapproved source under the
   explicit owner delegation, record file/spec hashes and base SHA, and create
   `batch/backend-NN` from the current integration head.
4. Spawn a new visible child attached explicitly to `env_mcqc2b9hng` with Codex
   `gpt-6.1-terra`, reasoning `high`, standard tier, and parent notifications auto.
   No new environment or worktree. It receives exactly one batch.

## Worker and review

The worker implements the full combined Task and obtains a separate read-only
Codex Terra 6.1 xhigh review in this same environment. Freeze the candidate SHA
for review; reviewers never modify source. A worker fixes confirmed in-scope
findings, proves every AC with exact tests/scenarios and logs, and runs the full
backend pipeline. Use the repository-pinned pnpm 9.12.0. Routine dependency or
ephemeral-Postgres setup is part of the work, not an automatic stop.

Use BLOCKED/NOT RUN honestly, inspect the actual test configuration, and never
claim file presence as proof. Exceptions require the parent's evidence-based
decision. The pilot's known macOS MCP environment assertion is an explicitly
accepted baseline failure; a changed or new failure is not automatically covered.
If external prerequisites prevent one action, continue unaffected authorized
work and send the parent concrete evidence and a proposed resolution.

After acceptance, merge the candidate locally using `--no-ff`, then perform the
existing guarded completion for aggregate and members with per-record handovers.
Preserve existing handover bytes: the CLI refuses a different handover at an
existing path. Add current acceptance evidence in
`issues/batches/backend/acceptance/batch-NN.md` and the aggregate handover; retain
source handovers as original implementation provenance. Validate and commit
completion metadata. This is not permission to bypass an approval/completion
guard or record a false pipeline PASS.

Return batch number, candidate/merge/completion SHAs, branch, exact results,
review/evidence paths and unresolved decisions. Do not start another batch or
archive yourself. The parent verifies the result, archives the worker, and only
then starts the next worker. This guarantees archival before next dispatch.

## Parent adjudication and continuation

On every completion notification, read real artifacts and current Git/issue
state. If incomplete, decide the concrete next fix or scope reconciliation and
resume that same worker. Do not advance merely because the worker ended a turn.
If accepted and integrated, archive it and dispatch the next incomplete main
batch. Repeat through batch 74. Do not process the two held web/client batches.

For batch 19, the parent commissions independent security review and records the
decision itself under delegated authority. Remove obsolete assumptions only
through explicit spec/decision changes and regenerated hashes. Do not fabricate
release tags, production checks, credentials or third-party human sign-off.
