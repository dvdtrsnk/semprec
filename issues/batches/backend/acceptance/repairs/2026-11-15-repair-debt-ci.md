# Repair receipt: repair-debt-ci

**Date:** 2026-11-15

A repair of the integration tip, as the section "Repairs of the integration tip" of `issues/batches/backend/CONTROLLER.md` describes. It brings tests in line with production behaviour and makes their scratch-database and process fixtures robust under load. It adds no behaviour, changes no production file and completes no source record.

**This repair does NOT cover every `mediaUnreadable` case.** The plain-writer cases of `transcriptionTask.test.ts` have a production cause that a test-only repair cannot remove; it is recorded below under "Not repaired and stays open" and becomes a new source.

- Repair branch: `repair/repair-debt-ci`, cut from `30753cc6e3489b9c3fb5ebea738434da43fd2647`. The branch is kept; its worktree is removed.
- Integration tip before the merge (PRE): `30753cc6e3489b9c3fb5ebea738434da43fd2647` on `feature/backend-parallel` ("Complete gh-1702 on the integration branch").
- Candidate commit: `dfc8e2d86b2863dcdfddcbf73578f6b1909fcb7d`. The branch holds three commits above PRE, not two: `717ac7b79` ("Repair four test debts of the integration tip"), `a2305ab2d` ("Guard the scratch pools of four more database fixtures and drop only closed databases", the worker's fix of the reviewer's findings) and `dfc8e2d86` ("Guard the pools of backupKeyRestore and drop its restored database only when closed", the controller's fix).
- Merge commit: `ffb53e010ec3c68eb3eab1865296f7944ff6b4e3` ("Merge repair repair-debt-ci", `--no-ff`, parents `30753cc6e` and `dfc8e2d86`). The receipt is committed on top of it as "Record the repair repair-debt-ci".
- Conflicts: none. The merge was automatic.
- Files changed: 15 under `backend/`, 14 test files and one test helper (`git diff --name-only 30753cc6e dfc8e2d86`). No production file, nothing under `issues/`.
  - `packages/data/src/__tests__/backupDeletionLedger.test.ts`
  - `packages/data/src/__tests__/backupKeyRestore.test.ts`
  - `packages/data/src/__tests__/docLastEditedMigration.test.ts`
  - `packages/data/src/__tests__/mailDraftsStore.test.ts`
  - `packages/data/src/__tests__/mailProviderAddressMigration.test.ts`
  - `packages/data/src/__tests__/mailServerSettingsStore.test.ts`
  - `packages/data/src/__tests__/mailSyncStatusMigration.test.ts`
  - `packages/data/src/__tests__/mailThreadAliases.test.ts`
  - `packages/data/src/__tests__/mailThreadBackfillCli.test.ts`
  - `packages/data/src/__tests__/migrationCompatibility.test.ts`
  - `packages/data/src/agentRuns/__tests__/agentRunsMcpClientNameMigration.test.ts`
  - `packages/data/src/mail/__tests__/bulkMailMigration.test.ts`
  - `packages/data/src/testSupport/dropClosedDatabase.ts` (new helper, not a test)
  - `services/alldots-api/src/__tests__/tenantIsolationRealtime.test.ts`
  - `services/alldots-transcribe/src/transcriptionTask.test.ts`

## Debts as the controller recorded them

The hosted CI of pull requests 2059, 2060 and 2066 failed intermittently on the items below, and the queue runner's own full-tier runs showed the same class. They are test debt of the integration tip, not defects of one landed chain, except where a cause is named.

| Debt | Test (as reported) | Cause per `worker.json` | Causing commit |
| --- | --- | --- | --- |
| Realtime strict `next()` consumers | `tenantIsolationRealtime.test.ts`, helpers `openDoc` and `watchRun` (the report named `packages/realtime/src/__tests__/`; the file lives under `services/alldots-api`) | The server sends the own-tenant doc invalidation after re-reading the doc, up to 1 s after a write. The earlier repair `a6923e5f5` set that echo aside only in `drainUntil`; `openDoc` and `watchRun` used a plain `socket.next()` and received a doc frame where they expected a binary one. | Mechanism and first set-aside: `745aea3f6`, `a6923e5f5`. Trigger only: gh-1811 (`69d0a19dd`), which added the `inboxCards` case whose confirm writes a doc. gh-1811's Task was not changed. |
| Uncaught 57P01 pool error at database drop | `mailSyncStatusMigration.test.ts` "upgrades historical mailbox sync states and preserves legacy writes", and, found by search, the same raw scratch pool in 10 more files (below) | A raw `pg` Pool without an `error` listener. `pool.end()` returns before the sockets of idle clients close, so `DROP DATABASE ... WITH (FORCE)` can still terminate such a backend; the 57P01 is emitted on the pool with no listener and vitest exits 1 after every test passed. | None (test debt since `745aea3f6`). |
| ffmpeg `mediaUnreadable` under load | `transcriptionTask.test.ts`, step 1 cases that use `storageWithMidNormalizationHook` (the report named `packages/data/src/__tests__/`; the file lives under `services/alldots-transcribe`) | The helper awaited its hook before the real `writeStream` started reading ffmpeg's stdout. When the hook (database work) outlasted ffmpeg, ffmpeg exited with stdout unread, Node dropped it, the stored audio was empty, `ffprobe` failed with `MediaToolError` and step 1 reported `mediaUnreadable` instead of reaching its write transaction. Test-only for these cases. | The helper was introduced by `3ce12d55a`. |
| `DROP DATABASE` timeouts under load | `mailThreadBackfillCli.test.ts` "runs the compiled migration root twice and queues one keyed mail-thread backfill; settles its creator and removes the database when a committed create acknowledgement is lost" | `DROP DATABASE` ran on a pool with `statement_timeout` 10 s and `query_timeout` 12 s shared with the fixture's other statements; the drop waits for other backends and ends with a checkpoint, so under load it was cancelled and the fixture reported "Owned fixture database removal was not established". Pools had no error handlers. | None (hygiene debt since `745aea3f6`). |

Attribution correction: the first commit `717ac7b79` carries the trailer `Repair-Of: gh-1811 (69d0a19dd)`, which attributes all four debts to gh-1811. The independent reviewer found that gh-1811 caused only the realtime item; `a2305ab2d` states the corrected attribution in its body (`Repair-Of: none, test debt since 745aea3f6` for the rest). The reviewed history was not rewritten. For the purpose of this record, gh-1811 is named for the realtime item only.

## What was changed in each test and how the worker showed it can still fail

The statements below are the worker's (`worker.json`); the queue runner did not repeat the mutations (NOT RUN).

- `tenantIsolationRealtime.test.ts`: new `TestSocket.nextSettingAsideOwnDocEcho` (the set-aside of `drainUntil`: a doc invalidation is dropped only after the admin pool confirmed that the item belongs to the socket's own tenant); `drainUntil`, `openDoc` and `watchRun` use it. A doc frame of another tenant is returned and fails. Shown: a synthetic own-tenant doc invalidation pushed into the queue of `a1` before `openDoc` passes with the fix and fails ("expected binary, received text") with `openDoc` reverted to `socket.next()`; a synthetic doc invalidation of a tenant B item fails with the fix (negative control). `watchRun` uses the same method and was not mutated separately. Whole file 70 of 70 in the worker's run.
- `mailSyncStatusMigration.test.ts` and the five FORCE-drop files `bulkMailMigration`, `agentRunsMcpClientNameMigration`, `docLastEditedMigration`, `mailProviderAddressMigration`, `mailServerSettingsStore`: error handler on the admin and scratch pools; the scratch pool is marked as ending before `end()`, and a 57P01 is tolerated only after that point, every other pool error is recorded as a failure. Shown: under CPU load (12 `yes` processes) the old `mailSyncStatusMigration` exited 1 with an unhandled 57P01 after "Tests 1 passed" in 1 of 6 runs; the new file exited 0 in 10 of 10 runs; emitting a non-57P01 error on the scratch pool before `end()` fails the test with that error. The same mechanism was not repeated per file for the other five.
- `mailDraftsStore.test.ts`, `mailThreadAliases.test.ts`, `backupDeletionLedger.test.ts`, `migrationCompatibility.test.ts`: new `testSupport/dropClosedDatabase.ts` (waits, 5 s with 10 ms steps, until `pg_stat_activity` shows no backend of the database, then a plain `DROP DATABASE`, never `FORCE`, never a termination; the wait moved there from `migrationCompatibility`). Error handlers on every raw pool, drops through `dropClosedDatabase`; in `migrationCompatibility` all 30 `new Pool` became `guardedPool` and an `afterEach` fails the test with an `AggregateError` of collected errors. In `backupDeletionLedger` the absence assertion is unchanged. Shown: an error emitted on the scratch pool of `mailDraftsStore`, on the restored pool of `backupDeletionLedger` and on every `guardedPool` of `migrationCompatibility` each failed the test with that error; a never-closed extra client on the scratch database in `mailThreadAliases` failed the drop wait ("remaining 1, expected 0"). Four files whole: 4 passed, 49 tests passed, 1 skipped (`it.skipIf(!BATCH29_BRIDGE_READER)`, pre-existing).
- `backupKeyRestore.test.ts` (commit `dfc8e2d86`, the controller's fix of review finding 1, applied literally as the reviewer proposed): error handlers on the `admin`, `runtime` and `target` pools, and `dropClosedDatabase(admin, "restored_cli")` instead of the immediate `DROP DATABASE restored_cli` after `target.end()`; the absence assertion that follows is unchanged. The controller reports 14 of 14 tests passing with prettier and eslint clean. No mutation check was made for this file (NOT RUN).
- `mailThreadBackfillCli.test.ts`: error handlers on all four pools (57P01 on the fixture pool is tolerated only once it is ending); the removal pool gets an explicit `statement_timeout` of 60 s (`query_timeout` 65 s), as the controller's reason asked, and before the `DROP`, `pg_terminate_backend` on `pg_stat_activity` filtered by `datname` = this fixture database and `pid <> pg_backend_pid()`. The removal assertion is unchanged. This is the only raised timeout of the repair, and only on that removal pool. Shown: `DROP` replaced by `SELECT 1` fails with "Owned fixture database removal was not established"; a drop statement timeout of 1 ms fails with "canceling statement due to statement timeout" plus the same message; a leaked idle backend of the fixture database passes with the termination and fails with "database ... is being accessed by other users" when the termination is removed. 3 of 3 tests pass.
- `transcriptionTask.test.ts`: the helper `storageWithMidNormalizationHook` starts the real write first and runs the hook beside it (`Promise.allSettled`); the hook failure is thrown after the write settled, otherwise the write's failure or result is returned. The hook still runs after the read transaction and before the write transaction. Shown: with the old helper a 3 s sleep in the hook gives code `mediaUnreadable` instead of `unknown`; with the new helper and the same sleep the test passes (the sleep was removed). Whole file 158 of 158 in the worker's run.
- No assertion was removed, skipped or loosened. No test timeout was raised.

## Reviewer

One reviewer from another context read `30753cc6e..a2305ab2d` (14 files: 13 test files and the helper) by reading only; it built and ran nothing. Verdict: **findings**.

| Finding | Severity | Outcome |
| --- | --- | --- |
| `backupKeyRestore.test.ts` kept the stale pool pattern the repair fixed in `backupDeletionLedger.test.ts`: raw pools `admin`, `runtime` and `target` without an `error` listener, and an immediate non-FORCE `DROP DATABASE restored_cli` after `target.end()`. | medium | Fixed by the controller in `dfc8e2d86`, applied literally as the reviewer's fix said (error handlers, `dropClosedDatabase`, absence assertion unchanged). The file passed 14 of 14, prettier and eslint clean. |
| The plain-writer `mediaUnreadable` cases of `transcriptionTask.test.ts` are not repaired; the repair must carry its `notRepaired` source and must not be described as covering every `mediaUnreadable` case. | low | Accepted as the reviewer's fix says: no change to the diff. Recorded below under "Not repaired and stays open", and the statement is at the top of this receipt. |

The reviewer also confirmed that only tests and the helper changed, that no statement matcher was added, that the realtime set-aside keeps the own-tenant check so another tenant's doc frame still fails, that the `Repair-Of` attribution of `717ac7b79` was wrong for three of the four debts (finding folded into `a2305ab2d`; see "Debts"), and it noted what it did not prove (that Node drops an unread child stdout after exit is analytical; the worker's load reproductions were not rerun).

**The fix commit `dfc8e2d86` had no second independent review.** The verdict above is the reviewer's verdict for `a2305ab2d`; `dfc8e2d86` is the controller's fix, applied literally as the reviewer proposed, and was gated here with the others.

## Landing gate

Run on the merged tree (`git merge --no-ff --no-commit`, before the merge commit) in the integration worktree, backend directory, with `npx -y pnpm@9.12.0`. Logs: `/Users/davidtresnak/.bb/thread-storage/thr_hc2df5gf4u/run/repairs/repair-debt-ci/land/` (`gate.sh`, `progress.txt`, one log per step, `files.txt`).

| Step | Result |
| --- | --- |
| `-r run build` | PASS (exit 0) |
| `run lint` | PASS (exit 0) |
| `run format:check` | PASS (exit 0, all matched files use Prettier code style) |
| `run test:unit` | PASS (exit 0; 238 files and 4785 tests, then the block-model suite, 4 files and 172 tests) |
| `run check:write-safety` | PASS (exit 0, 111 unsafe writes and 13 leaked connects, all in the baseline) |
| `run test:repo-scripts` | PASS (exit 0, 637 of 637) |
| `run check:boundaries` | PASS (exit 0, no violations, 7526 modules, 45120 dependencies) |
| `exec vitest run --config vitest.integration.config.ts` on the 14 test files the repair changed (`land/files.txt` without the helper) | PASS (exit 0; 14 files passed, 325 tests passed, 1 skipped, the pre-existing `skipIf`; about 230 s). No test was run again, none timed out, no failure occurred. |
| `node .github/scripts/issues.mjs validate` (after writing this receipt) | PASS (exit 0, `errors: []`, 1462 records counted) |
| `node issues/batches/backend/verify.mjs` (after writing this receipt) | PASS (exit 0; 675 sources, 74 main batches, 2 held batches) |
| `prettier --check` on this receipt | NOT RUN (none of the other repair receipts passes it, so the check was not applied here) |

## Not repaired and stays open

- **The plain-writer `mediaUnreadable` cases of `services/alldots-transcribe/src/transcriptionTask.test.ts`**, for example "rejects overlapping intake when prepare owns Files and keeps the committed prepare date" (reported at line about 1644 of a CI run). The repair covers only the cases that use `storageWithMidNormalizationHook`. The production cause of the rest, proved by the worker with a scratch test and not changed here: `LocalFsBlobStorageWriter.writeStream` (`packages/data/src/mail/blobStorage.ts`) awaits `mkdir` before `pipeline()` attaches to the source, and `streamFfmpegToStorage` (`mediaNormalization.ts`) spawns ffmpeg and hands `child.stdout` to `writeStream` unread; when ffmpeg exits before the first read, Node drops the unread stdout. With the real writer and a busy libuv threadpool the scratch run stored 0 bytes and `ffprobe` exited 1 (`MediaToolError`, classified `mediaUnreadable`); on an idle pool it stored 10843 bytes. Under CPU load alone 16 of 16 runs of the test passed, so the natural trigger is a busy threadpool or disk. Line 1644 at the tip is the second `createTranscriptionTask` call, which does no storage I/O, so the exact CI line is not explained by the tip code (the CI line numbers probably come from a branch version of the file); the mechanism explains the first worker of that test. Proposed change for the new source (production): in `streamFfmpegToStorage`, attach to ffmpeg's stdout in the tick of the spawn (for example `child.stdout.pipe(new PassThrough())`, destroyed on failure) and pass that stream to `blobStorage.writeStream`, or create the pipeline consumer before the first `await` in `LocalFsBlobStorageWriter.writeStream`. Test for it: a `BlobStorageWriter` whose `writeStream` waits 2 s before reading must still store the complete normalized output and no `mediaUnreadable` must be reported. A test-side wrapper that reads at once was deliberately not added, because it would hide that the production writer can store an empty normalized recording under load. The hosted CI can keep failing intermittently with `mediaUnreadable` in that test until the source lands.
- `packages/data/src/__tests__/mcpConnectionFactory.test.ts`: known baseline failure of this macOS host (`__CF_USER_TEXT_ENCODING`), not touched. It is not among the files of the gate run, so it was not run here.
- The fix commit `dfc8e2d86` had no second independent review (see "Reviewer").
- The worker's mutation checks and load reproductions were not repeated by the queue runner (NOT RUN), and no mutation check exists for `backupKeyRestore.test.ts`.
- The full integration tier, the end-to-end tier and `pnpm run verify` as a whole were NOT RUN on the merged tip; only the static checks and the 14 files above were.
- The repaired cases were not run by test title with `-t` (NOT RUN); they ran as part of their files.
