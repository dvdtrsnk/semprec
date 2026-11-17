# Repair receipt: effective-date-value-link-test

**Date:** 2026-11-12

A repair of the integration tip, as the section "Repairs of the integration tip" of `issues/batches/backend/CONTROLLER.md` describes. It brings two cases of one test in line with a field that a landed source now stores on every task write that names `date`. It adds no behaviour, changes no production file and completes no source record.

- Repair branch: `repair/effective-date-value-link-test`, cut from `491ac710a92138fe7ae3347d237642687efbfccc`.
- Integration tip before the merge: `491ac710a92138fe7ae3347d237642687efbfccc` on `feature/backend-parallel`. The tip had not moved since the branch was cut.
- Fix commit and candidate: `a52abcbafe612f03dde34506f30e944b18ad3882` ("Expect the stored effectiveDate in the value link date patch tests"), the only commit of the branch.
- Merge commit: `4a62b9cde9b79c2c4153ec5f9e760a6f9c848a47` (`--no-ff`, parents `491ac710a` and `a52abcbaf`).
- Conflicts: none. The merge was automatic.
- Files changed: one test file, `backend/packages/data/src/__tests__/valueLinkWrites.test.ts`, 2 insertions (a comment line and one property line). No production file, nothing under `issues/`.
- Causing source: gh-1780, commit `2ef71c1e4f5757d9b37b51fd0aa7ab25f27d092f` ("Derive task visibility and effective day from host events"), landed with chain `e1-059-tasks` by the merge `afbf8b67cdeaea573de7930fc5cf17e4d9c9f2e6`. It is an ancestor of the tip `491ac710a` (checked with `git merge-base --is-ancestor`).

## Failing tests as the full tier reported them

The whole integration tier ran on the tip `491ac710a92138fe7ae3347d237642687efbfccc`. `result.json` of that run reports status red, 618 files passed and 4 files failed, wall time 1403 s, and five failing entries. Each failing file was then run again alone. Logs are in `/Users/davidtresnak/.bb/thread-storage/thr_hc2df5gf4u/run/e1/full-2` (`result.json`, `shard-<i>.log`, `alone2-<file>.log`, `rerun-<file>.log`). A `shard-summary.json` in the same directory is dated 11:22 and names the older tip `f38226946`; it is not the record of this run and is not used here.

| # | File | Test | Alone | Class in `result.json` |
| --- | --- | --- | --- | --- |
| 1 | `backend/packages/data/src/__tests__/valueLinkWrites.test.ts` | value link state on writes (issue #1516) > valueLinks handoff > requires an active link for a retained legacy timeFrom canonicalized by a date patch: on | fail (`alone2-valueLinkWrites.log`: 2 failed, 99 passed of 101) | real |
| 2 | `backend/packages/data/src/__tests__/valueLinkWrites.test.ts` | value link state on writes (issue #1516) > valueLinks handoff > requires an active link for a retained legacy timeTo canonicalized by a date patch: on | fail (same run) | real |
| 3 | `backend/packages/data/src/__tests__/mcpConnectionFactory.test.ts` | MCP connection factory (issue #231) > stdio > gives the child exactly the inherited names, the config's env names and the credential name | fail (`alone2-mcpConnectionFactory.log`: 1 failed, 54 passed of 55) | baseline |
| 4 | `backend/packages/data/src/__tests__/mailDraftsStore.test.ts` | upgrades populated legacy state before installing the draft table | pass (`alone2-mailDraftsStore.log`: 12 passed) | load |
| 5 | `backend/packages/data/src/__tests__/migrationCompatibility.test.ts` | adds unverified classification without changing populated historical blobs | pass (`alone2-migrationCompatibility.log`: 27 passed, 1 skipped) | load |

Failure of rows 1 and 2, as `result.json` states it: the persisted properties contain an unexpected `"effectiveDate": "2026-10-14"` key after a date patch, while the exact `toEqual` expects only `name`, `date`, `timeFrom`, `timeTo` and `time`. Row 3 is the known baseline of the macOS delivery host (the child environment has one extra inherited name, `__CF_USER_TEXT_ENCODING`). Row 4 timed out at 30000 ms in the sharded run, and row 5 hit a statement timeout in `dropClosedDatabase` after 30.6 s; both are load failures and passed alone.

Rows 1 and 2 are what this repair fixes.

## Cause

gh-1780, commit `2ef71c1e4`, added `withEffectiveDate` to `taskPreWriteTransform` (`backend/packages/data/src/tasks/taskPreWriteTransform.ts`). Every task write that names `date` now also stores `effectiveDate`. With no host event, `effectiveDate` equals `date`, which is what the Task of gh-1780 (item 3(c) and its acceptance criterion about tasks without host events) requires. In the two cases the task rows are seeded through `itemsStore.insertItem` without `effectiveDate` and then patched with `date: 2026-10-14`, so the persisted row now carries `effectiveDate: "2026-10-14"`. The exact `toEqual` of the persisted properties in `valueLinkWrites.test.ts` did not list it. The behaviour the cases guard (a retained legacy `timeFrom` or `timeTo` that a date patch canonicalizes needs an active value link) did not change.

The causing commit and its reachability are established by the worker, the reviewer and the queue runner's `git merge-base --is-ancestor 2ef71c1e4 491ac710a` and `git log` of the merge `afbf8b67c`. The queue runner did not repeat the worker's search for other tests with exact property-set expectations.

## Fix

One commit, `a52abcbafe612f03dde34506f30e944b18ad3882`. The two cases are one `it.each` over `timeFrom` and `timeTo`, so the single exact `toEqual` of the persisted properties (line 1334 on the merged tree) now also lists `effectiveDate: "2026-10-14"`, with a one-line comment naming why. No assertion was removed, skipped or loosened, it stays an exact `toEqual`, and the 30000 ms test timeout is unchanged.

"How it can still fail" is the worker's evidence, from `worker.json` (`/Users/davidtresnak/.bb/thread-storage/thr_hc2df5gf4u/run/repairs/effective-date-value-link-test/worker.json`). The queue runner read the worker's record and did not repeat its baseline or scratch runs.

| Case | Change | How the worker showed it can still fail |
| --- | --- | --- |
| `requires an active link for a retained legacy timeFrom canonicalized by a date patch: on` | `effectiveDate: "2026-10-14"` added to the exact `toEqual` of the persisted properties (the shared expectation of the `it.each`). | Before the change the file failed with the stale expectation (an extra `effectiveDate` key; 2 failed, 99 passed). With the expected value set to the wrong date `2026-10-13` in a scratch change, later reverted, both cases failed with a diff on `effectiveDate` (2 failed, 4 passed in the `-t 'canonicalized by a date patch'` run). |
| `requires an active link for a retained legacy timeTo canonicalized by a date patch: on` | The same single shared expectation. | Same as the `timeFrom` case: failed before the change, and failed with a wrong `effectiveDate` value in the reverted scratch change. |

The worker's record states that it ran `pnpm -r run build`, then the file before the change (2 failed, 99 passed) and after it (101 passed), eslint and `prettier --check` on the file (both clean), and that the worktree was clean at the commit. It states that it searched the backend tests for other exact property-set expectations on tasks written with `date`; the other hits are non-task databases, Event steps or already updated by `2ef71c1e4` (`backfillTaskEffectiveDate.test.ts`, `taskHostEventRoutes.test.ts`), so no other test was repaired. It did not touch or run the known baseline failure in `mcpConnectionFactory.test.ts`.

The candidate changes no production file, which the queue runner confirmed with `git diff --name-only 491ac710a a52abcbaf` (the one test file).

## Review

One reviewer from another context read the range `491ac710a..a52abcbaf`. The review was read-only; the reviewer ran no build and no test. Its report is `/Users/davidtresnak/.bb/thread-storage/thr_hc2df5gf4u/run/repairs/effective-date-value-link-test/review.json`.

- Verdict: **clear**.
- Findings: none (`findings` is `[]`). There is no finding to dispose of.

What the reviewer checked by reading, from its report:

- The range is one commit changing one file, `valueLinkWrites.test.ts`, with 2 added lines. No production code, nothing under `issues/`.
- No statement matcher was changed: the repair is an exact-value expectation. No assertion was removed, skipped or loosened, `toEqual` stays exact and the timeout is unchanged. The value is specific, so a wrong date would still fail.
- The task is seeded without `effectiveDate`, so the date patch is what adds the key; the cases still prove that the retained legacy `timeFrom` or `timeTo` canonicalization needs an active link and that the write is otherwise unchanged.
- The cause: `2ef71c1e4` (gh-1780, an ancestor of `491ac710a`) added `withEffectiveDate` to `taskPreWriteTransform`; with no host event `computeTaskHostState` gives the date, so `2026-10-14`. Item 3(c) of gh-1780 and its acceptance criterion require exactly this, and the repair adds no behaviour.
- Other exact `toEqual` assertions on persisted task properties after a date write: `backfillTaskEffectiveDate.test.ts` and `taskHostEventRoutes.test.ts` already include `effectiveDate`; the `proposalActions.test.ts` assertions are proposal step diffs, not persisted rows, and are not in the failing set. The sibling case "does not require an omitted unchanged end-time link" uses `toMatchObject` and is unaffected.

Limit the reviewer states: it did not run any test.

## Gate on the merged tree

Run in `backend/` of the integration worktree with `npx -y pnpm@9.12.0`, on the merged tree before the merge was committed, from 22:33:07Z to about 22:36:27Z on 2026-11-12. The steps ran one after another as one background script; each ran once and none was retried. Logs are in `/Users/davidtresnak/.bb/thread-storage/thr_hc2df5gf4u/run/repairs/effective-date-value-link-test/land/`, one `<step>.log` per step with the exit code in `<step>.exit`.

| Step | Result | Note |
| --- | --- | --- |
| `-r run build` | PASS | exit 0 (`build.log`) |
| `run lint` | PASS | exit 0, no findings (`lint.log`) |
| `run format:check` | PASS | exit 0, all matched files use Prettier code style (`format.log`) |
| `run test:unit` | PASS | exit 0; 184 files, 3208 tests; block-model 4 files, 172 tests (`unit.log`) |
| `run check:write-safety` | PASS | exit 0; 112 unsafe writes and 12 leaked-connect calls, all already in the baseline (`writesafety.log`) |
| `run test:repo-scripts` | PASS | exit 0; 0 failed (`reposcripts.log`) |
| `run check:boundaries` | PASS | exit 0; no dependency violations (5584 modules, 30237 dependencies cruised) (`boundaries.log`) |
| Targeted integration run, every case except the known baseline case | PASS | 4 files, 196 tests: 194 passed, 1 skipped (the skipped case is in `migrationCompatibility.test.ts`, as in its run alone), 121.0 s. The process exited 1 because of the next row and of nothing else (`integration.log`). |
| Targeted integration run, the known baseline case of `mcpConnectionFactory.test.ts` | FAIL | "gives the child exactly the inherited names, the config's env names and the credential name": the child has the additional name `__CF_USER_TEXT_ENCODING`. This is the known baseline of the macOS delivery host, with the same diff as in the full tier. It is not a result of this repair and did not hold the landing. The other 54 tests of the file passed. |
| `install --frozen-lockfile` | NOT RUN | The merge changes neither the lockfile nor any `package.json`. |
| `run check:pi-import-paths` | NOT RUN | Not part of the gate set for this repair. The repair changes one integration test file. |
| `--filter @semprec/data run check-migration-numbering` | NOT RUN | Not part of the gate set for this repair. The repair adds no migration. |
| `run test:e2e` | NOT RUN | Not part of the gate set for this repair. The repair changes no end-to-end file and no production file. |
| Whole integration tier | NOT RUN | See "Not repaired and open". |

The targeted integration run was one process, `exec vitest run --config vitest.integration.config.ts` with four files: the file the repair changed and the other three files of the full tier's failure list.

| File | In the run because | Result |
| --- | --- | --- |
| `packages/data/src/__tests__/valueLinkWrites.test.ts` | repaired | passed, including both repaired cases (it was not among the failed files; the run reports one failed test in total) |
| `packages/data/src/__tests__/mcpConnectionFactory.test.ts` | failure list (baseline) | 54 passed, 1 failed (the baseline case) |
| `packages/data/src/__tests__/mailDraftsStore.test.ts` | failure list (load) | passed |
| `packages/data/src/__tests__/migrationCompatibility.test.ts` | failure list (load) | passed |

The run reports 3 files passed and 1 failed, and 1 failed, 194 passed and 1 skipped of 196 tests; the only failed test is the baseline case. No test ended in a 30 s timeout or a statement timeout, so no file was run a second time. The log contains `withTransaction: ROLLBACK failed; discarding the connection` entries at level 50 from the database tests; they did not fail any test and were not examined further. No test was edited at landing and no timeout was raised.

Record checks, run on the merge commit with this receipt in the tree: `node .github/scripts/issues.mjs validate` exited 0 with 0 errors over 1460 records (its `historical` list of "Model tier: missing" notes on old records is not an error), and `node issues/batches/backend/verify.mjs` exited 0 (673 sources, 74 main batches, 2 held batches). Logs: `records-validate.log` and `records-verify.log` in the `land/` directory above.

## Not repaired and open

- Of the two failures given to this repair, none is left unrepaired.
- The whole integration tier has not been run on the repaired tip. This receipt shows four files on the merged tree and nothing more. Whether the tier is green apart from the baseline is for the next full run to show.
- Row 3, the baseline case of `mcpConnectionFactory.test.ts`, still fails on this host. It is not part of this repair.
- Rows 4 and 5, the load failures in `mailDraftsStore.test.ts` and `migrationCompatibility.test.ts`, were not repaired and nothing was changed for them. They passed alone after the full run and passed in this gate's run of four files. They can fail again under the load of a full run.
- The expectation keys on `effectiveDate` equalling `date` when a task has no host event. A later source that changes how `effectiveDate` is derived for such a write has to update this test in its own change.
- Other exact property-set expectations on persisted task rows were searched by the worker and the reviewer only; the queue runner did not repeat the search. The full run found no other such failure on the tip `491ac710a`.
- No source record, handover or manifest entry is changed by this repair. gh-1780 stays as it was completed.
- The branch `repair/effective-date-value-link-test` is kept. Its worktree is removed once this receipt is committed. Nothing is pushed.

## FAIL, BLOCKED and NOT RUN

- FAIL: the known baseline case of `mcpConnectionFactory.test.ts` in the targeted integration run. No other gate step and no other test of this landing failed.
- BLOCKED: none.
- NOT RUN: the whole integration tier on the repaired tip.
- NOT RUN: `install --frozen-lockfile`, `run check:pi-import-paths`, `check-migration-numbering` and `run test:e2e`.
- NOT RUN at landing: the worker's baseline run of the unrepaired file and its scratch run with a wrong expected date. They are the worker's evidence; the queue runner read its record only.
- NOT RUN by the reviewer: any build or test.
- NOT RUN: anything against a deployed server or a production or staging database. Every test ran against the embedded test Postgres.
