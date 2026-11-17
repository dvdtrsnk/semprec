# Repair receipt: soft-delete-statement-tests

**Date:** 2026-11-11

A repair of the integration tip, as the section "Repairs of the integration tip" of `issues/batches/backend/CONTROLLER.md` describes. It brings three tests in line with a statement that a landed source changed. It adds no behaviour, changes no production file and completes no source record.

- Repair branch: `repair/soft-delete-statement-tests`, cut from `dfe0e25d8afac7d1a4157b50bcaac1696e1e425d`.
- Integration tip before the merge: `dfe0e25d8afac7d1a4157b50bcaac1696e1e425d` on `feature/backend-parallel`.
- Fix commit and candidate: `33ad3f4b5d2aad4154db8fc8c7ef4a72317edb92`, the only commit of the branch.
- Merge commit: `519183476128905a59af6dc9c508fd3942428a4d` (`--no-ff`, parents `dfe0e25d8` and `33ad3f4b5`).
- Conflicts: none. The merge was automatic. The tip had not moved since the branch was cut, so the tree of the merge commit is the tree of the candidate.
- Files changed: three test files under `backend/`, 8 insertions and 3 deletions. No production file, nothing under `issues/`.
- Causing source: gh-2029, commit `16e2e7483c796afc86a1f629de7aa169e6d22383`.

## Failing tests as the full tier reported them

The whole integration tier ran on the tip `9395a4c89ccc21085318ad70c3986aaf59ca3ad0` as four shard processes, from 2026-11-11T09:09:41Z to 09:27:21Z: 8675 tests passed and 8 failed, in seven files. Each failing file was then run again alone. Logs are in `/Users/davidtresnak/.bb/thread-storage/thr_hc2df5gf4u/run/e1/full-ctl-1` (`shard-<i>.log`, `shard-<i>.json`, `failures.json`, `result.json`, `alone-<file>.log`).

`failures.json` and `result.json` cut a test name after 150 characters, so they name the first test without "with delete-first" and end the second at "rollup-recompute st". The names below are the full names from `shard-1.json` and `shard-2.json`. "Class" is the classification in `result.json`.

| # | Shard | File | Test | Message | Alone | Class |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | `backend/packages/application/src/__tests__/genericOperationGateway.test.ts` | createGenericOperationGateway (issue #220) > page.restoreVersion through the approval gate (issue #1617) > coordinates actual approved replay and deletion with delete-first | `Error: barrier timed out` | fail (1 failed, 75 passed) | real |
| 2 | 2 | `backend/packages/data/src/__tests__/inboxPipeline.test.ts` | Inbox pipeline databases (issue #101) > deleting a type referenced by locked and unlocked Inbox items reserves cards and mirrors the rollup-recompute step | `AssertionError: expected -1 to be greater than or equal to 0` | fail (1 failed, 14 passed) | real |
| 3 | 2 | `backend/packages/data/src/__tests__/transcriptDelete.test.ts` | DELETE /api/transcripts/:id and its restore (issue #1642) > rolls everything back when the transcript's source changes before the transcript is locked | `Error: promise resolved "{ status: 200, body: { …(2) } }" instead of rejecting` | fail (1 failed, 9 passed) | real |
| 4 | 1 | `backend/packages/data/src/__tests__/mcpConnectionFactory.test.ts` | MCP connection factory (issue #231) > stdio > gives the child exactly the inherited names, the config's env names and the credential name | `AssertionError: expected [ 'HOME', 'LOGNAME', …(6) ] to deeply equal [ 'HOME', 'LOGNAME', …(5) ]` | fail (1 failed, 54 passed) | baseline |
| 5 | 1 | `backend/services/semprec-api/src/__tests__/cacheControl.test.ts` | Cache-Control on every API response (issue #1072) > GET /api/blobs/:id answers an unsatisfiable range (416) with no-store | `TypeError: fetch failed` | pass (140 passed) | load |
| 6 | 2 | `backend/packages/data/src/__tests__/mailThreadBackfillCli.test.ts` | runs the compiled migration root twice and queues one keyed mail-thread backfill | `error: canceling statement due to statement timeout` | pass (3 passed) | load |
| 7 | 2 | `backend/packages/data/src/__tests__/mailThreadBackfillCli.test.ts` | settles its creator and removes the database when a committed create acknowledgement is lost | `Error: Injected lost CREATE acknowledgement` | pass (3 passed) | load |
| 8 | 4 | `backend/packages/data/src/__tests__/mailDraftsStore.test.ts` | upgrades populated legacy state before installing the draft table | `Error: STACK_TRACE_ERROR` | pass (12 passed) | load |

Rows 1 to 3 reproduced alone and are what this repair fixes. Row 4 is the known baseline of the delivery host. Rows 5 to 8 passed alone and are load failures; this repair does not touch them.

The repair was cut two commits after the tip the full tier ran on (`52af7e4bc` and `dfe0e25d8`). Those two commits change files under `issues/` only; `git diff --name-only 9395a4c89 dfe0e25d8 -- backend` is empty.

## Cause

gh-2029, commit `16e2e7483c796afc86a1f629de7aa169e6d22383` ("Soft-delete a removed mailbox's folders and messages in a chunked job"), landed with chain `e1-002-mail` by the merge `9ffd8dbf995198a8971c8ac7356d5397d2412e1f` and is reachable only through that merge's second parent.

It changed the statement of `softDeleteItem` in `backend/packages/data/src/chokePoint/itemsStore.ts` from

```
UPDATE items SET deleted_at = now() WHERE database_id = $1 AND id = $2 AND deleted_at IS NULL
```

to

```
UPDATE items SET deleted_at = COALESCE($3::timestamptz, now())
      WHERE database_id = $1 AND id = $2 AND deleted_at IS NULL
```

with the parameters `[databaseId, itemId, deletedAtExact ?? null]`, so the cascade of a mailbox removal can be stamped with the Mailboxes item's own deletion time. Without an exact epoch the row still gets the transaction's `now()`.

Each of the three tests recognises this production statement by its first words and still looked for `UPDATE items SET deleted_at = now()`. In rows 1 and 3 a proxy on the pool's `query` therefore never fired; in row 2 the search over the recorded statements returned -1. The behaviour the tests guard did not change.

The queue runner read the diff of `16e2e7483` for `itemsStore.ts`, the statement on the merged tree (`itemsStore.ts`, line 296) and the reachability of the commit. That `16e2e7483` is the only commit since `561bd71ea` that changed the statement, and that no commit after it touched the three test files, is the result of the worker's `git log -S` and of the reviewer's; the queue runner did not repeat that search.

## Fix

One commit, `33ad3f4b5d2aad4154db8fc8c7ef4a72317edb92` ("Match the soft-delete statement of gh-2029 in three tests"). In each test the matched text is now the current first line of the production statement, `UPDATE items SET deleted_at = COALESCE($3::timestamptz, now())`. No `expect`, no timeout, no `skip` or `only` and no other line changed.

"How it can still fail" is the worker's evidence. Its logs are in `/Users/davidtresnak/.bb/thread-storage/thr_hc2df5gf4u/run/repairs/soft-delete-statement-tests/`: `01-baseline.log` (the unrepaired files at `dfe0e25d8`: 3 failed, 98 passed), `02-repaired.log` (3 files, 101 passed), `03-mutation-behaviour-broken.log` (repaired tests against three scratch changes of production files: 4 failed, 97 passed) and `04-final-verbose.log` (after the scratch changes were reverted, the committed content: 3 files, 101 passed). The queue runner read the result lines and the failure messages of these logs and found them as the worker reports them. It did not repeat the baseline run or the mutation runs.

| Test | Change | How the worker showed it can still fail |
| --- | --- | --- |
| Row 1, `genericOperationGateway.test.ts`, the `delete-first` case of the `it.each` | The `startsWith` text of the barrier in the proxy on the deleting pool's `client.query` (lines 3413 to 3416 on the merged tree); Prettier wrapped the condition over four lines. The 5000 ms barrier and the 15000 ms test timeout are unchanged. The `replay-first` case does not use this proxy and passed before and after. | Stale matcher: at the base commit the case fails with `Error: barrier timed out` (`01-baseline.log`). Guarded behaviour broken: with a scratch change in `backend/packages/data/src/docs/docPageRestore.ts` (`requirePageDoc` no longer calls `lockItemById`, so the restore does not lock the live item) the case fails with `AssertionError: expected undefined to be defined` at `expect(waitingPid).toBeDefined()`: the barrier fired and the test saw that the replay did not wait for the deletion. The `replay-first` sibling failed in that run too (`expected false to be true`). |
| Row 2, `inboxPipeline.test.ts` | The `includes` text of the `findIndex` over the recorded statements of `deleteInboxTypeWithClient` (lines 652 to 654); Prettier wrapped the call over three lines. Both assertions (the index is at least 0; exactly one `rollup_dependencies` lookup follows the soft delete) are unchanged. | Stale matcher: at the base commit the test fails with `AssertionError: expected -1 to be greater than or equal to 0` (`01-baseline.log`). Guarded behaviour broken: with a scratch change in `backend/packages/data/src/inbox/inboxTypesStore.ts` that dropped the loop enqueueing the rollup recompute of the remaining edges, the index assertion passes and the test fails at the next one with `AssertionError: expected [] to have a length of 1 but got +0`. |
| Row 3, `transcriptDelete.test.ts` | The `startsWith` text in the pool proxy that relinks the transcript right after the handler's soft delete of the source Files item (line 361). One line. The condition `values[1] === f.file.id` still holds, because the item id is still the second parameter. | Stale matcher: at the base commit the test fails with `AssertionError: promise resolved "{ status: 200, body: { …(2) } }" instead of rejecting`, because the relink never runs (`01-baseline.log`). Guarded behaviour broken: with a scratch change that removed the changed-source check (the `ConflictError` "The transcript's source file changed during the delete") from `transcriptionRouteHandlers.ts` the test fails with the same message. The two cases differ in whether the relink ran; that the repaired matcher fires is shown by the passing run, where `expect(relinked).toBe(true)` (line 386) holds. |

The worker reverted the three scratch changes with `git checkout` before its final run and its commit. The candidate changes no production file, which the queue runner confirmed with `git diff --name-only dfe0e25d8 33ad3f4b5` (the three test files only).

## Review

One reviewer from another context read the range `dfe0e25d8..33ad3f4b5`. The review was read-only; the reviewer ran no build and no test.

- Verdict: **clear**.
- Findings: none. There is no finding to dispose of.

What the reviewer checked by reading, from its report:

- The range is one commit whose parent is the integration tip. It modifies exactly the three test files; no production file and nothing under `issues/`.
- The new text is character for character the first line of `softDeleteItem` (`itemsStore.ts`, line 296) with no leading whitespace, so `startsWith` and `includes` both hit. The only other production `UPDATE` of `items.deleted_at` is `restoreItem` (`= NULL`), which the text does not match.
- The word-level diff shows only the string literal and Prettier's line wraps. No `expect`, no `skip` or `only` and no timeout changed.
- `16e2e7483` is the only commit since `561bd71ea` that changed the statement, and no commit after it touched the three test files. Step 3 of the Task of gh-2029 requires that every row the removal job soft-deletes gets the Mailboxes item's own `deleted_at`, and the optional exact epoch implements that. Without an epoch `COALESCE(NULL, now())` is the former `now()`, so the behaviour the three tests guard is unchanged.
- Every remaining occurrence of the old text in the repository is a statement a test sends itself as a fixture. No other test matches the soft-delete statement by its text, by a regular expression or by its `WHERE` line.

Limits the reviewer states: it did not survey matchers of other production statements, and it read the worker's logs without reproducing them.

## Gate on the merged tree

Run in `backend/` of the integration worktree with `npx -y pnpm@9.12.0`, on the merged tree before the merge was committed, from 2026-11-11T09:46:28Z to 09:50:41Z. The steps ran one after another; each ran once and none was retried. Logs are in `/Users/davidtresnak/.bb/thread-storage/thr_hc2df5gf4u/run/repairs/soft-delete-statement-tests/land/`, one `<step>.log` per step with the exit code in its last line, `status.txt` and `integration.json`.

| Step | Result | Note |
| --- | --- | --- |
| `-r run build` | PASS | exit 0 (`build.log`) |
| `run lint` | PASS | exit 0, no findings (`lint.log`) |
| `run format:check` | PASS | exit 0, all matched files use Prettier code style (`format.log`) |
| `run test:unit` | PASS | exit 0; 166 files, 2726 tests; block-model 4 files, 172 tests (`unit.log`) |
| `run check:write-safety` | PASS | exit 0; 111 unsafe writes and 12 leaked-connect calls, all in the baseline (`write-safety.log`) |
| `run test:repo-scripts` | PASS | exit 0; 637 tests, 0 failed (`repo-scripts.log`) |
| `run check:boundaries` | PASS | exit 0; no dependency violations (4966 modules, 25525 dependencies cruised) (`boundaries.log`) |
| Targeted integration run, every case except the known baseline case | PASS | 7 files, 311 tests: 310 passed, none skipped, 156.7 s. The process exited 1 because of the next row and of nothing else (`integration.log`, `integration.json`). |
| Targeted integration run, the known baseline case of `mcpConnectionFactory.test.ts` | FAIL | "gives the child exactly the inherited names, the config's env names and the credential name": the child has the additional name `__CF_USER_TEXT_ENCODING`. This is the known baseline of the macOS delivery host, with the same diff as in the full tier's `alone-mcpConnectionFactory.log`. It is not a result of this repair and did not hold the landing. The other 54 tests of the file passed. |
| `install --frozen-lockfile` | NOT RUN | The merge changes neither the lockfile nor any `package.json`. |
| `run check:pi-import-paths` | NOT RUN | Not part of the gate set for this repair. The repair changes three integration test files. |
| `--filter @semprec/data run check-migration-numbering` | NOT RUN | Not part of the gate set for this repair. The repair adds no migration. |
| `run test:e2e` | NOT RUN | Not part of the gate set for this repair. The repair changes no end-to-end file and no production file. |
| Whole integration tier | NOT RUN | See "Not repaired and open". |

The targeted integration run was one process, `exec vitest run --config vitest.integration.config.ts` with seven files: the three files the repair changed and the other four files of the full tier's failure list.

| File | In the run because | Result |
| --- | --- | --- |
| `packages/application/src/__tests__/genericOperationGateway.test.ts` | repaired | 76 passed |
| `packages/data/src/__tests__/inboxPipeline.test.ts` | repaired | 15 passed |
| `packages/data/src/__tests__/transcriptDelete.test.ts` | repaired | 10 passed |
| `packages/data/src/__tests__/mcpConnectionFactory.test.ts` | failure list (baseline) | 54 passed, 1 failed (the baseline case) |
| `services/semprec-api/src/__tests__/cacheControl.test.ts` | failure list (load) | 140 passed |
| `packages/data/src/__tests__/mailThreadBackfillCli.test.ts` | failure list (load) | 3 passed |
| `packages/data/src/__tests__/mailDraftsStore.test.ts` | failure list (load) | 12 passed |

Each test of rows 1 to 3 and 5 to 8 of the failure table was looked up by name in `integration.json` and has status passed; so has the `replay-first` sibling of row 1. No test ended in a 30 s timeout or a statement timeout, so no file was run a second time. No test was edited at landing and no timeout was raised.

Record checks, run on the merge commit with this receipt in the tree: `node .github/scripts/issues.mjs validate` reported 0 errors over 1458 records, and `node issues/batches/backend/verify.mjs` exited 0 (`records-validate.log`, `records-verify.log`).

## Not repaired and open

- Of the three failures given to this repair, none is left unrepaired.
- The whole integration tier has not been run on the repaired tip. This receipt shows the seven files above on the merged tree and nothing more. Whether the tier is green apart from the baseline is for the next full run to show.
- Row 4, the baseline case of `mcpConnectionFactory.test.ts`, still fails on this host. It is not part of this repair.
- Rows 5 to 8, the load failures in `cacheControl.test.ts`, `mailThreadBackfillCli.test.ts` (two cases) and `mailDraftsStore.test.ts`, were not repaired and nothing was changed for them. They passed alone after the full run and passed in this gate's run of seven files. They can fail again under the load of a full run.
- The three matchers still key on the literal first line of the statement. A later source that edits that line has to update these three tests in its own change.
- Tests that key on the text of other production statements were not surveyed, neither by the worker nor by the reviewer. The full run found no other such failure on the tip `9395a4c89`.
- Chain `e1-007-shared` (gh-1699): the controller reports that its landing was abandoned because of row 1. It stays unlanded; landing it again is the controller's. The worker read the diffs of `chain/e1-007-shared` and `chain/e1-009-shared`: both change `genericOperationGateway.test.ts` but not the repaired line. Nobody made a trial merge of either chain with this repair.
- No source record, handover or manifest entry is changed by this repair. gh-2029 stays as it was completed.
- The branch `repair/soft-delete-statement-tests` is kept. Its worktree is removed once this receipt is committed. Nothing is pushed.

## FAIL, BLOCKED and NOT RUN

- FAIL: the known baseline case of `mcpConnectionFactory.test.ts` in the targeted integration run. No other gate step and no other test of this landing failed.
- BLOCKED: none.
- NOT RUN: the whole integration tier on the repaired tip.
- NOT RUN: `install --frozen-lockfile`, `run check:pi-import-paths`, `check-migration-numbering` and `run test:e2e`.
- NOT RUN at landing: the worker's baseline run of the unrepaired files and its mutation run against the three scratch changes. They are the worker's evidence; the queue runner read their logs.
- NOT RUN by the reviewer: any build or test.
- NOT RUN: anything against a deployed server or a production or staging database. Every test ran against the embedded test Postgres.
