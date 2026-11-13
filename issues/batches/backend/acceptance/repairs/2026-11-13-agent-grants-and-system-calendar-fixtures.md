# Repair receipt: agent-grants-and-system-calendar-fixtures

**Date:** 2026-11-13

A repair of the integration tip, as the section "Repairs of the integration tip" of `issues/batches/backend/CONTROLLER.md` describes. It brings seven integration test files in line with two landed sources: per-database agent grants (gh-1810) and the protection of system and default calendars (gh-1803). It adds no behaviour, changes no production file and completes no source record.

- Repair branch: `repair/agent-grants-and-system-calendar-fixtures`, cut from `4dd156d24f0a9716d1d20dfc41636e85e766bc6b`.
- Integration tip before the merge: `4dd156d24f0a9716d1d20dfc41636e85e766bc6b` on `feature/backend-parallel`. The tip had not moved since the branch was cut.
- Fix commit and candidate: `252b70ecc2e7b0509f70e6340a1f5d6cd00f2492` ("Bring agent-grant and system-calendar test fixtures in line with the landed hooks"), the only commit of the branch.
- Merge commit: `d3445a9538a5ad9ccbd6720ff003f8c17dc6dad3` ("Merge repair agent-grants-and-system-calendar-fixtures", `--no-ff`, parents `4dd156d24` and `252b70ecc`).
- Conflicts: none. The merge was automatic.
- Files changed: seven test files under `backend/`, 89 insertions and 8 deletions. No production file, nothing under `issues/`. Checked with `git diff --name-only 4dd156d24 252b70ecc`.
- Causing sources, both ancestors of the tip (`git merge-base --is-ancestor`):
  - gh-1810, commit `be97305af` ("Enforce per-database agent grants in the data layer"), from chain `e1-077-chokepoint`.
  - gh-1803, commit `ffbd45364` ("Trash and restore a calendar together with its Events").

## Failing tests as the full tier reported them

The whole integration tier ran as four shard processes, then each failing file was run again alone. `result.json` of that run reports status red, 639 files passed and 12 files failed, wall time 1871 s, and 46 failing entries. Its own `tip` field names `b9a7035003f92cb0415def6bbeb26a3453171262`. The tip given to this repair, `4dd156d24f0a9716d1d20dfc41636e85e766bc6b`, is the next commit and only adds explicit timeouts to three calendar cutover test cases, so the repaired files are the same on both. Logs are in `/Users/davidtresnak/.bb/thread-storage/thr_hc2df5gf4u/run/e1/full-2` (`result.json`, `shard-<i>.log`, `alone2-*.log`, `alone3-*.log`, `alone3-summary.txt`, `rerun-*.log`). `shard-summary.json` and `rerun-summary.txt` in that directory belong to an older run on tip `f38226946` and are not used here.

Entries that `result.json` classifies as real and that failed alone (38 entries in 6 files). These are what this repair fixes.

| File (under `backend/`) | Entries | Cases as reported (suffix after the describe name) |
| --- | --- | --- |
| `services/semprec-api/src/__tests__/sleepWritePaths.test.ts` | 19 | describe "sleep value rules and one-item-per-key rules through REST and the agent gateway (issue gh-1784)". Create refusals: goalMinutes 485, alarmSound gong, wakeDays mon and mon, bedTime 7:5, wakeTime 25:00, alarm yes, night 2026-13-01, a night alarm yes. Patch refusals (agent item.patch): goalMinutes 485, wakeDays mon and mon, bedTime 25:00, bedTime 7:5, night 2026-13-01, a night wakeTime 25:00. Also: "stores bedTime 6:45 as 06:45 and accepts wakeDays [] through gateway", "answers a second settings item with 409 duplicate_item through gateway", "answers a second exception for a night with 409 duplicate_item through gateway", "answers a night moved onto an occupied date with 409 duplicate_item through gateway", "moves fri from the weekday plan to the weekend plan with one patch through gateway, without an approval step". |
| `services/semprec-api/src/__tests__/selectValueWritePaths.test.ts` | 15 | describe "Health records select values are judged alike through REST, the agent gateway and MCP (issue gh-1802)". Create refusals: tags neznamy, tags medication and neznamy, status ghost, type as a number. Patch refusals: the same four. Also: "names the unknown tag in the message of the gateway and of MCP", "accepts tags [medication] on a create and on a patch through gateway", the same through mcp, "clears tags with null and with an empty array through gateway", the same through mcp, "accepts a patch that resends the unchanged unknown values of a record through gateway", the same through mcp. |
| `packages/data/src/__tests__/relationEdgeChangedHook.test.ts` | 1 | relation edge changed hooks > reports create, update and internal delete, but not dry-run or missing delete |
| `packages/data/src/journal/__tests__/journalDayEvents.test.ts` | 1 | journal day events and birthdays (issues #1721, #2015) > keeps a birthday with no Birthdays calendar in the list, with a null calendarId |
| `packages/data/src/calendar/__tests__/timelineHolidaySource.test.ts` | 1 | public holiday timeline source (issue #1804) > gives a null calendarId when the holidays calendar is in the trash |
| `packages/data/src/calendar/__tests__/timelineBirthdaySource.test.ts` | 1 | birthday timeline source (issue #1800) > gives a null calendarId when the Birthdays calendar is in the trash |

The agent-gateway and MCP cases of the first two files answered `403 forbidden` or threw `ForbiddenError` ("The agent's project has no write access to database ...") instead of the expected `validation_failed` or `duplicate_item` result. The relation case failed with `invalid input syntax for type uuid: "project"`. The three calendar cases threw `ForbiddenError` when the fixture trashed a system calendar.

Entries of the same run that this repair does not address (8 entries):

| File | Test | Alone | Class in `result.json` |
| --- | --- | --- | --- |
| `packages/data/src/__tests__/mcpConnectionFactory.test.ts` | MCP connection factory (issue #231) > stdio > gives the child exactly the inherited names, the config's env names and the credential name | fail | baseline |
| `packages/data/src/__tests__/acceptInvitation.test.ts` | acceptInvitation (issue #1087) > a database migrated by runMigrations alone has no single-tenant guard and accepts a second tenant | pass | load |
| `services/semprec-ai-gateway/src/__tests__/completeHandler.test.ts` | POST /internal/complete > image content blocks > answers 413 for a 9 MiB body even when it contains an image | pass | load |
| `packages/data/src/__tests__/mailDraftsStore.test.ts` | upgrades populated legacy state before installing the draft table | pass | load |
| `packages/data/src/__tests__/migrationCompatibility.test.ts` | adds unverified classification without changing populated historical blobs; preserves populated users when the display name migration runs; adds the move state table over populated mail without changing existing metadata (3 entries) | pass | load |
| `services/semprec-api/src/__tests__/authHandler.test.ts` | POST /api/auth/password-change (issue #1701) > answers two simultaneous changes with the same currentPassword with one 200 and one 403 | pass | load |

The load entries timed out or hit a statement timeout in the sharded run and passed alone (`alone3-summary.txt`: exit 0 for each). The baseline case is the known failure of the macOS delivery host. `alone3-summary.txt` shows exit 1 for exactly the six files of the table above and `mcpConnectionFactory`.

## Cause

- gh-1810, `be97305af`, added `assertWriterDatabaseAccess` to `itemWrites.ts` and `relationOps.ts`. The Health records database and the three Sleep system databases are sensitive and closed to an agent's project without a stored grant, so the gateway and MCP paths answer `ForbiddenError` before they reach validation or the duplicate rule. The fixtures of `sleepWritePaths` and `selectValueWritePaths` stored no grant. A relation write by an agent also binds `agentProjectItemId` to a uuid column, and `relationEdgeChangedHook` passed the string `"project"`.
- gh-1803, `ffbd45364`, added `calendarItemDeleteHook`, which refuses to trash a system or subscription calendar, and hands the default mark to Work when the default calendar is deleted. Three timeline and journal tests trashed the Birthdays or holidays calendar through `softDeleteItem` to reach the "calendar in the trash" state, which now throws. `eventCreateWithRelations` did not fail yet, but its fixture no longer produced a tenant without a live default calendar and so no longer tested its branch.

The queue runner did not re-derive the causes; they are the worker's and the reviewer's, checked by the reviewer against the code and the Tasks of gh-1810 and gh-1803.

## Fix

One commit, `252b70ecc2e7b0509f70e6340a1f5d6cd00f2492`. "How it can still fail" is the worker's evidence from `/Users/davidtresnak/.bb/thread-storage/thr_hc2df5gf4u/run/repairs/agent-grants-and-system-calendar-fixtures/worker.json`. The queue runner read the record and did not repeat the worker's baseline or scratch runs.

| File | Change | How the worker showed it can still fail |
| --- | --- | --- |
| `sleepWritePaths.test.ts` | `beforeEach` stores a write grant in `agent_database_grants` for the agent's project and each of `sleepSettings`, `sleepPlans`, `sleepNights`, with the statement of `setAgentDatabaseGrant`, asserting `rowCount` 1. The admin store is not exported from `@semprec/data`, as in `genericOperationAgentGrants.test.ts`. | The goalMinutes check in `sleepWriteHooks.ts` disabled: the goalMinutes 485 create and patch cases failed. Grant stored as `read`: gateway cases failed with `ForbiddenError`. Both reverted. |
| `selectValueWritePaths.test.ts` | `beforeEach` stores a write grant for the agent's project on the Health records database, same statement, `rowCount` 1. The MCP credential is minted for the same project. | `assertSelectValuesKnown` in `itemWrites.ts` made to accept unknown options: 7 cases failed. Grant stored as `read`: gateway and MCP cases failed with `ForbiddenError`. Both reverted. |
| `relationEdgeChangedHook.test.ts` | The writer's `agentProjectItemId` is a real Projects item from `createTestProjectItem(pool)`. The databases in the test are user-created and stay open without a grant. | Unrepaired file reproduced the uuid error. The op of the first `runRelationEdgeChangedHooks` call in `relationOps.ts` changed from create to update: the test failed. Reverted. |
| `journalDayEvents.test.ts` | New helper `trashCalendarWithoutHooks` puts the calendar in the Trash with a raw `UPDATE items SET deleted_at = now()` in a tenant transaction on the admin pool, `rowCount` 1, with a comment. | `readSystemCalendarId` stopped excluding trashed calendars: the test failed. The unrepaired file reproduced the `ForbiddenError`. Reverted. |
| `timelineHolidaySource.test.ts` | `trashHolidaysCalendar` does the same raw `UPDATE` through `withTenantTransaction` (imported from `testDb`), `rowCount` 1, with a comment. | Same scratch change to `readSystemCalendarId`: the test failed. Reverted. |
| `timelineBirthdaySource.test.ts` | `trashCalendar` does the same raw `UPDATE`, `rowCount` 1, with a comment. | Same scratch change: the test failed. Reverted. |
| `eventCreateWithRelations.test.ts` | The default calendar Personal is put in the Trash with a raw `UPDATE` (`rowCount` 1) so the tenant really has no live default, with a comment. | `defaultCalendarCreateHook.ts` made to throw when the tenant has no live default: the repaired test failed, while the unrepaired `softDeleteItem` version still passed (26 of 26), which shows it had stopped testing its branch. Reverted. |

The worker's record also states: `pnpm -r run build`, the six target files after the repairs (105 tests passed), the four data files unrepaired (4 files failed with the reported causes), a scratch `read` grant on the two services files (34 cases failed with `ForbiddenError`), all seven repaired files at the end (131 tests passed), prettier and eslint on the seven files (exit 0), and `git diff feature/backend-parallel..HEAD` touching only the seven test files. It searched the backend tests for the same stale patterns: other calendar trashes are of own non-last calendars that the hook allows (`defaultCalendarCreateHook`, `calendarCancellationImpact`), and other agent writers use uuid project ids or SQL of their own. No assertion was removed, skipped or loosened and no timeout was changed. Scratch backups are in the run directory of the repair.

## Review

One reviewer from another context read the range `4dd156d24..252b70ecc`. The review was read-only; the reviewer ran no build and no test. Its report is `/Users/davidtresnak/.bb/thread-storage/thr_hc2df5gf4u/run/repairs/agent-grants-and-system-calendar-fixtures/review.json`.

- Verdict: **clear**.
- Findings: none (`findings` is `[]`). There is no finding to dispose of.

What the reviewer checked by reading: one commit, seven files, all under `__tests__`, no production code, nothing under `issues/`; only additions apart from eight replaced lines; the raw `UPDATE` sets the same column as `softDeleteItem` and the readers of the state key on `deleted_at IS NULL`, and the same raw-write fixture already exists in `calendarRowHooks.test.ts`, `defaultCalendarCreateHook.test.ts` and `eventDefaultCalendarWritePaths.test.ts`; the grant `INSERT` mirrors `setAgentDatabaseGrant`; no assertion removed, skipped or loosened, no timeout touched, each new fixture asserts `rowCount` 1; causes confirmed in the code of both commits and against the Tasks of gh-1810 and gh-1803; `eventCreateWithRelations` was not in the failure list and its change is justified; a search of the other tests found no remaining trash of a system or default calendar and no agent writer with a non-uuid project id that reaches a database. Limit the reviewer states: it did not run any test, and the worker's mutation claims were not re-executed.

## Gate on the merged tree

Run in `backend/` of the integration worktree with `npx -y pnpm@9.12.0`, on the merged tree before the merge was committed, from 02:49:48Z to 02:54:28Z on 2026-11-13. The steps ran one after another as one background script; each ran once and none was retried. Logs are in `/Users/davidtresnak/.bb/thread-storage/thr_hc2df5gf4u/run/repairs/agent-grants-and-system-calendar-fixtures/land/`, one `<step>.log` per step with the exit code in `<step>.exit`.

| Step | Result | Note |
| --- | --- | --- |
| `-r run build` | PASS | exit 0 (`build.log`) |
| `run lint` | PASS | exit 0, no findings (`lint.log`) |
| `run format:check` | PASS | exit 0, all matched files use Prettier code style (`format.log`) |
| `run test:unit` | PASS | exit 0; 192 files, 3458 tests; block-model 4 files, 172 tests (`unit.log`) |
| `run check:write-safety` | PASS | exit 0; 112 unsafe writes and 12 leaked-connect calls, all already in the baseline (`writesafety.log`) |
| `run test:repo-scripts` | PASS | exit 0; 637 passed, 0 failed (`reposcripts.log`) |
| `run check:boundaries` | PASS | exit 0; no dependency violations (5773 modules, 31543 dependencies cruised) (`boundaries.log`) |
| Targeted integration run, every case except the known baseline case | PASS | 13 files; 12 files passed, 408 tests passed and 1 skipped, 196.6 s. The process exited 1 because of the next row and of nothing else (`integration.log`). |
| Targeted integration run, the known baseline case of `mcpConnectionFactory.test.ts` | FAIL | "gives the child exactly the inherited names, the config's env names and the credential name": the child has the additional name `__CF_USER_TEXT_ENCODING`. Known baseline of the macOS delivery host, same diff as in the full tier. Not a result of this repair and did not hold the landing. The other 54 tests of the file passed. |
| `install --frozen-lockfile` | NOT RUN | The merge changes neither the lockfile nor any `package.json`. |
| `run check:pi-import-paths` | NOT RUN | Not part of the gate set for this repair. |
| `--filter @semprec/data run check-migration-numbering` | NOT RUN | Not part of the gate set for this repair. The repair adds no migration. |
| `run test:e2e` | NOT RUN | Not part of the gate set for this repair. No end-to-end file and no production file changed. |
| Whole integration tier | NOT RUN | See "Not repaired and open". |

The targeted integration run was one process, `exec vitest run --config vitest.integration.config.ts` with 13 files: the seven files the repair changed (including `eventCreateWithRelations.test.ts`) and the six other files of the full tier's failure list (`mcpConnectionFactory`, `acceptInvitation`, `completeHandler`, `mailDraftsStore`, `migrationCompatibility`, `authHandler`). All six repaired failing files passed, including every case of `sleepWritePaths` and `selectValueWritePaths`. The load files passed. No test ended in a 30 s timeout or a statement timeout, so no file was run a second time. No test was edited at landing and no timeout was raised.

Record checks, run on the merge commit with this receipt in the tree: `node .github/scripts/issues.mjs validate` and `node issues/batches/backend/verify.mjs`; `issues.mjs validate` exited 0 with 0 errors over 1460 records (its list of "Model tier: missing" notes on old records is not an error), and `verify.mjs` exited 0 (673 sources, 74 main batches, 2 held batches). Logs: `records-validate.log` and `records-verify.log` in the `land/` directory above.

## Not repaired and open

- Of the 38 entries given to this repair, none is left unrepaired.
- The whole integration tier has not been run on the repaired tip. This receipt shows 13 files on the merged tree and nothing more. Whether the tier is green apart from the baseline is for the next full run to show.
- The baseline case of `mcpConnectionFactory.test.ts` still fails on this host. It is not part of this repair.
- The seven load entries (`acceptInvitation`, `completeHandler`, `mailDraftsStore`, `migrationCompatibility` x3, `authHandler`) were not repaired and nothing was changed for them. They passed alone after the full run and passed in this gate. They can fail again under the load of a full run.
- The grant fixtures store the grant with the SQL of `setAgentDatabaseGrant`, not by calling it, because the admin store is deliberately not exported from `@semprec/data`. If the statement or the table of `agent_database_grants` changes, the two services tests (and the other tests that do the same) have to follow.
- The raw `UPDATE` fixtures bypass the calendar delete hook on purpose. A later source that changes how a trashed system calendar is read has to update these tests in its own change.
- Other stale patterns were searched by the worker and the reviewer only; the queue runner did not repeat the search. The full run found no other failure of these two kinds.
- No source record, handover or manifest entry is changed by this repair. gh-1810 and gh-1803 stay as they were completed.
- The branch `repair/agent-grants-and-system-calendar-fixtures` is kept. Its worktree is removed once this receipt is committed. Nothing is pushed.

## FAIL, BLOCKED and NOT RUN

- FAIL: the known baseline case of `mcpConnectionFactory.test.ts` in the targeted integration run. No other gate step and no other test of this landing failed.
- BLOCKED: none.
- NOT RUN: the whole integration tier on the repaired tip.
- NOT RUN: `install --frozen-lockfile`, `run check:pi-import-paths`, `check-migration-numbering` and `run test:e2e`.
- NOT RUN at landing: the worker's baseline runs of the unrepaired files and its scratch mutations. They are the worker's evidence; the queue runner read its record only.
- NOT RUN by the reviewer: any build or test.
- NOT RUN: anything against a deployed server or a production or staging database. Every test ran against the embedded test Postgres.
