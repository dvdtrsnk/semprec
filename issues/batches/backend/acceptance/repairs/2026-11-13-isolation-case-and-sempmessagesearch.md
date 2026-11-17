# Repair receipt: isolation-case-and-sempmessagesearch

**Date:** 2026-11-13

A repair of the integration tip, as the section "Repairs of the integration tip" of `issues/batches/backend/CONTROLLER.md` describes. It adds the one tenant isolation case that a landed source made necessary. It adds no behaviour, changes no production file and completes no source record.

- Repair branch: `repair/isolation-case-and-sempmessagesearch`, cut from `86bf7a7777ddf5a88a190f6c7c051faa5d890b38`.
- Integration tip before the merge: `86bf7a7777ddf5a88a190f6c7c051faa5d890b38` on `feature/backend-parallel`. It is the tip the full tier tested and the parent of the fix commit, so the tip had not moved since the tier ran.
- Fix commit and candidate: `10a0dbc2678571c1bf3c8f30b9c8e4f1c37b100a` ("Add the calendarSendEventInvitation case to the api tenant isolation test"), the only commit of the branch, with the trailer `Repair-Of: e1-051-calendar (943c1539b)`.
- Merge commit: `0d276162baa179b265f32b16047d06abb44424c8` ("Merge repair isolation-case-and-sempmessagesearch", `--no-ff`, parents `86bf7a777` and `10a0dbc26`).
- Conflicts: none. The merge was automatic.
- Files changed: one test file under `backend/`. No production file, nothing under `issues/`. Checked with `git diff --name-only 86bf7a777 10a0dbc26`, which lists exactly `backend/services/semprec-api/src/__tests__/tenantIsolationJobs.test.ts`.
- Causing source, an ancestor of the tip (`git merge-base --is-ancestor`): gh-1774, commit `943c1539b7e4ef0bf1e7ca03b4f162359d233eed` ("Send meeting invitations, updates and cancellations"), from chain `e1-051-calendar` (gh-1762, gh-1774), merge `eff6b23b5`. The controller also named `80563519d` and `74c0a12f5` of that chain as suspects; both are ancestors of the tip. The worker and the reviewer put the cause on `943c1539b`, which added the task.

A note on the key. The repair key ends in "sempmessagesearch", but the failure list handed to this repair holds one entry only, the isolation case below. Nothing about a Semp message search was in the failure list, in the worker's record or in the reviewer's record, and nothing about it was repaired. If a second failure was meant to belong to this key, it is not covered here (see "Not repaired and open").

## Failing tests as the full tier reported them

The whole integration tier ran on the tip `86bf7a7777ddf5a88a190f6c7c051faa5d890b38` as four shard processes, then each failing file was run again alone. Its `result.json` reports status red, 675 files passed, 7 files failed, wall time 1923 s, tests 12804 in total with 10 failed (1 baseline, 1 real, 8 load). Logs are in `/Users/davidtresnak/.bb/thread-storage/thr_hc2df5gf4u/run/e1/full-1` (`result.json`, `shard-<i>.log`, `alone-<file>.log`, `build.log`).

The entry that `result.json` classifies as real and that failed alone (1 entry in 1 file). This is what this repair fixes.

| File (under `backend/`) | Entry as reported | Failure as reported |
| --- | --- | --- |
| `services/semprec-api/src/__tests__/tenantIsolationJobs.test.ts` | background task isolation across two tenants: api runtime (issue #1056) > has exactly one case per task of the api affinity set | The api affinity set contains the module task `calendarSendEventInvitation`, but the test file has no isolation case for it (`withoutCase: [calendarSendEventInvitation]`); fails identically alone. |

Entries of the same run that this repair does not address (9 entries):

| File | Test | Alone | Class in `result.json` |
| --- | --- | --- | --- |
| `packages/data/src/__tests__/mcpConnectionFactory.test.ts` | MCP connection factory (issue #231) > stdio > gives the child exactly the inherited names, the config's env names and the credential name | fail | baseline |
| `packages/data/src/__tests__/mailThreadBackfillCli.test.ts` | runs the compiled migration root twice and queues one keyed mail-thread backfill; settles its creator and removes the database when a committed create acknowledgement is lost | pass | load |
| `packages/data/src/__tests__/mailThreadAliases.test.ts` | upgrades populated legacy state before installing the alias table | pass | load |
| `packages/data/src/__tests__/mailDraftsStore.test.ts` | upgrades populated legacy state before installing the draft table | pass | load |
| `packages/data/src/__tests__/migrationCompatibility.test.ts` | adds unverified classification without changing populated historical blobs; preserves populated users when the display name migration runs | pass | load |
| `packages/data/src/__tests__/tenantEntity.test.ts` | tenant entity (issue #968) > on a scratch database > creates exactly one active tenant zero that the sole-tenant functions resolve; binds only the earliest pre-existing user to tenant zero as admin | pass | load |

The load entries hit a 30 s test timeout or a statement timeout in the sharded run under four concurrent shards and passed alone. The baseline case is the known failure of the macOS delivery host.

## Cause

gh-1774, `943c1539b`, added the task `calendarSendEventInvitation` with queue affinity `api` to `calendarModuleManifest.ts`, and the binding `setEventInvitationDelivery` (ADR 2026-11-12). It added no case to the `cases` record of `tenantIsolationJobs.test.ts`. The test "has exactly one case per task of the api affinity set" compares `resolveTaskAffinitySets().api` with `Object.keys(cases)`, so it failed. The Task of gh-1774 (step 5) required that task declaration and the queue runtime wiring, so the production behaviour is what the Task required.

The queue runner did not re-derive the cause; it is the worker's and the reviewer's, and the reviewer checked it against the manifest and the Task of gh-1774. The queue runner checked only that the commits are ancestors of the tip.

## Fix

One commit, `10a0dbc2678571c1bf3c8f30b9c8e4f1c37b100a` (146 insertions, 0 deletions, one file). "How it can still fail" is the worker's evidence from `/Users/davidtresnak/.bb/thread-storage/thr_hc2df5gf4u/run/repairs/isolation-case-and-sempmessagesearch/worker.json`. The queue runner read the record and did not repeat the worker's baseline or scratch runs.

| File | Change | How the worker showed it can still fail |
| --- | --- | --- |
| `tenantIsolationJobs.test.ts` | Added a tenant case for `calendarSendEventInvitation`. The test binds `setEventInvitationDelivery` on the runtime role pool with a recording transport factory and unbinds it in `afterAll`. `seed` creates a mailbox with its own address, an Event and a person invited through the system writer, and returns a REQUEST payload. `expectDone` asserts exactly one REQUEST left, from A's mailbox, to the invited address, in A's tenant scope, and that `sentAt` is stored on A's edge. The (b) test asserts that B's job naming A's ids sends nothing and ends like a job with random ids. The generic (a) and (b) tests also check the fingerprints of B and of tenant zero unchanged, A unchanged, and notifications. | Scratch change, reverted: the case key renamed, and the exactly-one-case test failed (`withoutCase`). Scratch change, reverted: `transport.send` removed in `eventInvitationJob.ts`, and (a) failed with no message sent. Scratch change, reverted: delivery bound to the admin pool (no tenant scope), and (a) and (b) failed (outcome error, "Module id events resolves to 3 system databases"). |

The worker's record also states: `install --frozen-lockfile` and `-r run build` in `backend`; the target file after the repair (122 tests passed); the same file with `-t "calendarSendEventInvitation|exactly one case"` (4 tests passed); the isolation files of `semprec-transcribe` and `semprec-agents` and `packages/data` `publicSurface.test.ts` (22 tests passed); prettier and eslint on the changed file (clean); `tsc --noEmit` in `services/semprec-api` (ok); `productionFilesChanged` empty. No assertion was removed or loosened and no timeout was changed. A CANCEL-specific isolation case was not added: one case per task is the convention of the file, and the CANCEL path reads only the mailbox through the same tenant-scoped pool.

## Review

One reviewer from another context read the range `86bf7a777..10a0dbc26`. The review was read-only; the reviewer ran no test and built nothing. Its report is `/Users/davidtresnak/.bb/thread-storage/thr_hc2df5gf4u/run/repairs/isolation-case-and-sempmessagesearch/review.json`.

- Verdict: **clear**.
- Findings: none (`findings` is `[]`). There is no finding to dispose of.
- A remark the reviewer states, not a finding: the `beforeAll` comment "Composed exactly as createApiQueueRuntime composes it" is slightly less literal, because the binding is set directly with a recording transport and not through `createMailTransportFactory`. The added comment states this. Nothing was changed for it.

What the reviewer checked by reading: one commit, one test file, 146 insertions, 0 deletions, nothing under `issues/`. No matcher or statement pattern was changed, so no production statement can match the new text. The recording transport keys on the MIME header written at `backend/packages/data/src/mail/outgoingMime.ts:156`, the same regex that `outgoingMime.ts:253` uses; a mismatch would make `method` null and fail the `toEqual`. The bound pool is the runtime-role pool (`semprec_data`), so the test would fail if the handler ran outside tenant scope. The cause was confirmed against `943c1539b` and the Task of gh-1774. A search found no other test that enumerates the api affinity set, and the calendar task is api only. Limit the reviewer states: it ran no test and did not re-execute the worker's mutation claims.

## Gate on the merged tree

Run in `backend/` of the integration worktree with `npx -y pnpm@9.12.0`, on the merged tree before the merge was committed, from 07:20:36Z to 07:22:29Z on 2026-11-13. The steps ran one after another as one background script (`gate.sh`); each ran once and none was retried. Logs are in `/Users/davidtresnak/.bb/thread-storage/thr_hc2df5gf4u/run/repairs/isolation-case-and-sempmessagesearch/land/`, one `<step>.log` per step with the exit code in `<step>.exit` (the integration step's `integration.exit` holds 0).

| Step | Result | Note |
| --- | --- | --- |
| `-r run build` | PASS | exit 0 (`build.log`) |
| `run lint` | PASS | exit 0, no findings (`lint.log`) |
| `run format:check` | PASS | exit 0, all matched files use Prettier code style (`format.log`) |
| `run test:unit` | PASS | exit 0; 199 files, 3686 tests; block-model 4 files, 172 tests (`unit.log`) |
| `run check:write-safety` | PASS | exit 0; 112 unsafe writes and 12 leaked-connect calls, all already in the baseline (`writesafety.log`) |
| `run test:repo-scripts` | PASS | exit 0; 637 passed, 0 failed (`reposcripts.log`) |
| `run check:boundaries` | PASS | exit 0; no dependency violations (5997 modules, 33075 dependencies cruised) (`boundaries.log`) |
| Integration run, `exec vitest run --config vitest.integration.config.ts services/semprec-api/src/__tests__/tenantIsolationJobs.test.ts` | PASS | exit 0; 1 file, 122 tests passed, 11.6 s (`integration.log`). The file the repair changed is also the only file of the failure list given to this repair. |
| `install --frozen-lockfile` | NOT RUN | The merge changes neither the lockfile nor any `package.json`. |
| `run check:pi-import-paths` | NOT RUN | Not part of the gate set for this repair. |
| `--filter @semprec/data run check-migration-numbering` | NOT RUN | Not part of the gate set for this repair. The repair adds no migration. |
| `run test:e2e` | NOT RUN | Not part of the gate set for this repair. No end-to-end file and no production file changed. |
| Whole integration tier | NOT RUN | See "Not repaired and open". |

No test ended in a 30 s timeout or a statement timeout, so no file was run a second time. No test was edited at landing and no timeout was raised. The known baseline case of `mcpConnectionFactory.test.ts` was not in the integration run, because that file is neither changed by the repair nor in the failure list given to it.

Record checks, run on the merge commit with this receipt in the tree: `node .github/scripts/issues.mjs validate` and `node issues/batches/backend/verify.mjs`; `issues.mjs validate` exited 0 with an empty `errors` list (its "Model tier: missing" notes on old records are not errors), and `verify.mjs` exited 0 (673 sources, 74 main batches, 2 held batches). Logs: `records-validate.log` and `records-verify.log` in the `land/` directory above.

## Not repaired and open

- Of the 1 real entry given to this repair, none is left unrepaired.
- Nothing about a Semp message search was given to this repair, and nothing about it was repaired or examined. The key of the repair names it; the failure list does not. If a failure belongs there, it stays open.
- The whole integration tier has not been run on the repaired tip. This receipt shows 1 integration file on the merged tree and nothing more. Whether the tier is green apart from the baseline is for the next full run to show.
- The baseline case of `mcpConnectionFactory.test.ts` still fails on this host. It is not part of this repair.
- The eight load entries (`mailThreadBackfillCli` 2 tests, `mailThreadAliases`, `mailDraftsStore`, `migrationCompatibility` 2 tests, `tenantEntity` 2 tests) were not repaired and nothing was changed for them. They passed alone after the full run. They were not run in this gate and can fail again under the load of a full run.
- A CANCEL-specific isolation case was not added (worker's decision, see "Fix").
- Other stale patterns were searched by the worker and the reviewer only; the queue runner did not repeat the search.
- No source record, handover or manifest entry is changed by this repair. gh-1762 and gh-1774 stay as they were completed.
- The branch `repair/isolation-case-and-sempmessagesearch` is kept. Its worktree is removed once this receipt is committed. Nothing is pushed.

## FAIL, BLOCKED and NOT RUN

- FAIL: none. No gate step and no test of this landing failed.
- BLOCKED: none.
- NOT RUN: the whole integration tier on the repaired tip.
- NOT RUN: `install --frozen-lockfile`, `run check:pi-import-paths`, `check-migration-numbering` and `run test:e2e`.
- NOT RUN: the baseline case of `mcpConnectionFactory.test.ts` and the eight load entries in this gate.
- NOT RUN at landing: the worker's baseline runs of the unrepaired file and its scratch mutations. They are the worker's evidence; the queue runner read its record only.
- NOT RUN by the reviewer: any build or test.
- NOT RUN: anything against a deployed server or a production or staging database. Every test ran against the embedded test Postgres.
