# Repair receipt: redacted-read-text-and-tenant-table-count

**Date:** 2026-11-13

A repair of the integration tip, as the section "Repairs of the integration tip" of `issues/batches/backend/CONTROLLER.md` describes. It brings two integration test files in line with two landed sources: the redaction of sensitive tool results in the stored agent run history (gh-1827) and the new tenant table `library_cover_candidates` (gh-1812). It adds no behaviour, changes no production file and completes no source record.

- Repair branch: `repair/redacted-read-text-and-tenant-table-count`, cut from `65aa8a274b4457cc43061775eca9089046e6565b`.
- Integration tip before the merge: `65aa8a274b4457cc43061775eca9089046e6565b` on `feature/backend-parallel`. It is the parent of the fix commit, so the tip had not moved since the branch was cut.
- Fix commit and candidate: `bc6995ab1963fd9ea5424fcad475ea37b2668a95` ("Bring two integration tests in line with the redaction and the new tenant table"), the only commit of the branch.
- Merge commit: `d709666218527918daf27318872eb5dc8ef01cbb` ("Merge repair redacted-read-text-and-tenant-table-count", `--no-ff`, parents `65aa8a274` and `bc6995ab1`).
- Conflicts: none. The merge was automatic.
- Files changed: two test files under `backend/`. No production file, nothing under `issues/`. Checked with `git diff --name-only 65aa8a274 bc6995ab1`, which lists exactly:
  - `backend/packages/data/src/__tests__/rowLevelSecurity.test.ts`
  - `backend/services/semprec-agents/src/__tests__/sempTurnReadAllowances.test.ts`
- Causing sources, both ancestors of the tip (`git merge-base --is-ancestor`):
  - gh-1827, commit `ba4fc32c3` ("Redact sensitive tool results from agent run history"), from chain `e1-097-agent-runtime`, merge `5520e870e`.
  - gh-1812, commit `0bdf371b39d2c51e6ffd01d87b70b208890b074a` ("Store library cover candidates and let the user pick one"), from chain `e1-102-library`, merge `b2f65a450`.

## Failing tests as the full tier reported them

The whole integration tier ran as four shard processes, then each failing file was run again alone. The tier's `result.json` reports status red, 657 files passed, 11 files failed, wall time 2483 s, and 11 failing entries. Its own `tip` field names `2b356c00ead56c1cb2d314eaa638da06fadc0200`. The tip given to this repair, `65aa8a274b4457cc43061775eca9089046e6565b`, is the next commit ("Raise the ESLint heap limit and order two realtime NOTIFY assertions"; `git diff --stat 2b356c00e 65aa8a274` shows only `backend/package.json` and `backend/packages/realtime/src/__tests__/realtime.test.ts`), so the repaired files are the same on both; the worker and the reviewer read the diff against `65aa8a274`, and the repaired files are the ones the tier reported. The file `tip.txt` in the same directory holds `cc5bc9db97acea804dc8e5d766e3ee3c80be2bee` and is stale, as `result.json` itself says of the older files in that directory. Logs are in `/Users/davidtresnak/.bb/thread-storage/thr_hc2df5gf4u/run/e1/full-1` (`result.json`, `shard-<i>.log`, `alone-<file>.log`, `build.log`).

Entries that `result.json` classifies as real and that failed alone (2 entries in 2 files). These are what this repair fixes.

| File (under `backend/`) | Entry as reported | Failure as reported |
| --- | --- | --- |
| `services/semprec-agents/src/__tests__/sempTurnReadAllowances.test.ts` | one-turn read allowances of a Semp turn (issue #1849) > a turn that attaches a health record > lets the agent read the attached record in that turn without a grant, refuses another record of the database, refuses the attached record outside the turn | Shard 1 and alone: `read.text` is `[redacted: sensitive]` but the test expects it to contain `Attached record` (`sempTurnReadAllowances.test.ts:243`). |
| `packages/data/src/__tests__/rowLevelSecurity.test.ts` | row-level security as the runtime roles (whole suite, 14 tests skipped because `beforeAll` failed) | Shard 4 and alone: expected `tenantTables` `toHaveLength(67)` but got 68 (`rowLevelSecurity.test.ts:107`). |

Entries of the same run that this repair does not address (9 entries):

| File | Test | Alone | Class in `result.json` |
| --- | --- | --- | --- |
| `packages/data/src/__tests__/mcpConnectionFactory.test.ts` | MCP connection factory (issue #231) > stdio > gives the child exactly the inherited names, the config's env names and the credential name | fail | baseline |
| `packages/data/src/__tests__/acceptInvitation.test.ts` | acceptInvitation (issue #1087) > a database migrated by runMigrations alone has no single-tenant guard and accepts a second tenant | pass | load |
| `packages/data/src/__tests__/mailServerSettingsStore.test.ts` | mail server settings store (issue #1473) > upgrades a populated pre-0101 database with the real migration runner | pass | load |
| `packages/data/src/__tests__/mailThreadBackfillCli.test.ts` | runs the compiled migration root twice and queues one keyed mail-thread backfill; settles its creator and removes the database when a committed create acknowledgement is lost | pass | load |
| `packages/data/src/__tests__/mailThreadAliases.test.ts` | upgrades populated legacy state before installing the alias table | pass | load |
| `packages/data/src/agentRuns/__tests__/agentRunsThreadMigration.test.ts` | upgrades populated runs on the historical single-tenant schema with the real migration runner | pass | load |
| `packages/data/src/__tests__/mailDraftsStore.test.ts` | upgrades populated legacy state before installing the draft table | pass | load |
| `packages/data/src/__tests__/migrationCompatibility.test.ts` | adds unverified classification without changing populated historical blobs | pass | load |
| `services/semprec-transcribe/src/transcriptionTask.test.ts` | transcription steps 4-8 > retries and permanent failures (issue #248) > rerun of a finished transcript without meeting notes (issue #1712) > pays no speaker suggestion call for ... (`TranscriptionQueueError: Transcription task failed`) | pass | load |

The load entries hit a 30 s or 120 s test timeout or a statement timeout in the sharded run under four concurrent shards and passed alone. The baseline case is the known failure of the macOS delivery host (the child process has the extra name `__CF_USER_TEXT_ENCODING`).

## Cause

- gh-1827, `ba4fc32c3`, stores the `tool_result` of a content-bearing operation on a sensitive database as `[redacted: sensitive]` and keeps the real result live in the turn. The Health records database is sensitive. The test of gh-1849 (`f7058f9fb`, chain `e1-096-semprec-agents`, merge `8e9060754`) read the stored `agent_run_events` text and expected `Attached record`. gh-1849 landed before gh-1827, so its test was not written against the redaction; neither chain ran against the other.
- gh-1812, `0bdf371b3`, added the tenant table `library_cover_candidates` (migration `0156_library_cover_candidates.sql`, comment `semprec:tenancy=tenant`). gh-1849 had moved the hard-coded count to 67 with `agent_run_read_allowances`, so the count became 68. The migration was merged without updating `rowLevelSecurity.test.ts`.

The queue runner did not re-derive the causes; they are the worker's and the reviewer's, and the reviewer checked them against the code and the Tasks of gh-1827 and gh-1812. The queue runner checked only that both commits are ancestors of the tip.

## Fix

One commit, `bc6995ab1963fd9ea5424fcad475ea37b2668a95`, with trailers `Repair-Of: gh-1827 (ba4fc32c3)` and `Repair-Of: gh-1812 (0bdf371b3)`. "How it can still fail" is the worker's evidence from `/Users/davidtresnak/.bb/thread-storage/thr_hc2df5gf4u/run/repairs/redacted-read-text-and-tenant-table-count/worker.json`. The queue runner read the record and did not repeat the worker's baseline or scratch runs.

| File | Change | How the worker showed it can still fail |
| --- | --- | --- |
| `sempTurnReadAllowances.test.ts` | A faux provider step now captures the tool result the model sees in the live turn, and the test expects it to contain `Attached record`. The stored text is expected to be exactly `[redacted: sensitive]` while `isError` stays false. All other assertions are unchanged. | Scratch change, reverted: `readAllowedItemIds` ignored its refs, so the attached record was refused and the test failed with `expected true to be false`. Scratch change, reverted, with agent-runtime rebuilt before and after: `redactSensitiveToolResult` returned the message unchanged and the test failed on the stored text `to be [redacted: sensitive]`. The old stale matcher was not re-run by the worker; the controller reported its failure. |
| `rowLevelSecurity.test.ts` | `toHaveLength(67)` became `toHaveLength(68)` and `library_cover_candidates` was added to the `arrayContaining` list of expected tenant tables. | Scratch change, reverted: the count set back to 67 failed with `to have a length of 67 but got 68`. Scratch change, reverted: a list name changed to `library_cover_candidatez` failed the `arrayContaining` assertion. |

The worker's record also states: `install --frozen-lockfile` and `-r run build` in `backend`; the two target files after the repair (2 files, 37 tests passed, before and after the scratch checks); prettier and eslint on both files (pass); `tsc --noEmit` in `services/semprec-agents` (no errors); `productionFilesChanged` empty. It searched the backend tests for the same two stale patterns and found none: `sleepNightRefExpansion.test.ts` asserts only `isError` and `forbidden` on refusals, and no other test hard-codes the tenant table count. No assertion was removed or loosened and no timeout was changed. The worker did not run the baseline `mcpConnectionFactory.test.ts`.

## Review

One reviewer from another context read the range `65aa8a274..bc6995ab1`. The review was read-only; the reviewer ran no test. Its report is `/Users/davidtresnak/.bb/thread-storage/thr_hc2df5gf4u/run/repairs/redacted-read-text-and-tenant-table-count/review.json`.

- Verdict: **clear**.
- Findings: none (`findings` is `[]`). There is no finding to dispose of.
- Remaining nit the reviewer states, not a finding: the test uses the literal `[redacted: sensitive]`, as `agentRun.e2e.test.ts` does, and not the exported constant. Nothing was changed for it.

What the reviewer checked by reading: only the two test files changed, no production code, nothing under `issues/`. For `rowLevelSecurity`, the matcher is a catalog query (comment `semprec:tenancy=tenant`) plus an exact length; the reviewer counted 69 tenancy=tenant comments in the migrations, minus `resource_grants` dropped in 0082, which gives 68; the exact length is kept, so a later table still fails the count. For `sempTurnReadAllowances`, no assertion was removed or loosened and no timeout touched; the stored-text `toContain` is replaced by two stronger assertions; only successful content-bearing results are marked for redaction, so the `forbidden` assertions on error results are unaffected, and `isError` stays false after redaction; the faux step order and count are unchanged and the helper types are valid for pi-ai 0.85.1. The cause is confirmed against the Tasks of gh-1827 and gh-1812. A search of other tests that read `agent_run_events` tool_result text (`sleepNightRefExpansion`, `sempThreadPrompt`, `tenantIsolationRoutes`, `agentRun.e2e`) found only `isError` or error text, already-redacted expectations, or non-sensitive data. Limit the reviewer states: it ran no test and did not re-execute the worker's mutation claims.

## Gate on the merged tree

Run in `backend/` of the integration worktree with `npx -y pnpm@9.12.0`, on the merged tree before the merge was committed, from 05:23:43Z to about 05:28:32Z on 2026-11-13. The steps ran one after another as one background script (`gate.sh`); each ran once and none was retried. Logs are in `/Users/davidtresnak/.bb/thread-storage/thr_hc2df5gf4u/run/repairs/redacted-read-text-and-tenant-table-count/land/`, one `<step>.log` per step with the exit code in `<step>.exit`.

| Step | Result | Note |
| --- | --- | --- |
| `-r run build` | PASS | exit 0 (`build.log`) |
| `run lint` | PASS | exit 0, no findings (`lint.log`) |
| `run format:check` | PASS | exit 0, all matched files use Prettier code style (`format.log`) |
| `run test:unit` | PASS | exit 0; 195 files, 3568 tests; block-model 4 files, 172 tests (`unit.log`) |
| `run check:write-safety` | PASS | exit 0; 112 unsafe writes and 12 leaked-connect calls, all already in the baseline (`writesafety.log`) |
| `run test:repo-scripts` | PASS | exit 0; 637 passed, 0 failed (`reposcripts.log`) |
| `run check:boundaries` | PASS | exit 0; no dependency violations (5913 modules, 32420 dependencies cruised) (`boundaries.log`) |
| Targeted integration run, every case except the known baseline case | PASS | 11 files; 10 files passed, 335 tests passed and 1 skipped, 206.3 s. The process exited 1 because of the next row and of nothing else (`integration.log`). |
| Targeted integration run, the known baseline case of `mcpConnectionFactory.test.ts` | FAIL | "gives the child exactly the inherited names, the config's env names and the credential name": the child has the additional name `__CF_USER_TEXT_ENCODING`. Known baseline of the macOS delivery host, same diff as in the full tier. Not a result of this repair and did not hold the landing. |
| `install --frozen-lockfile` | NOT RUN | The merge changes neither the lockfile nor any `package.json`. |
| `run check:pi-import-paths` | NOT RUN | Not part of the gate set for this repair. |
| `--filter @semprec/data run check-migration-numbering` | NOT RUN | Not part of the gate set for this repair. The repair adds no migration. |
| `run test:e2e` | NOT RUN | Not part of the gate set for this repair. No end-to-end file and no production file changed. |
| Whole integration tier | NOT RUN | See "Not repaired and open". |

The targeted integration run was one process, `exec vitest run --config vitest.integration.config.ts` with 11 files: the two files the repair changed (`sempTurnReadAllowances`, `rowLevelSecurity`) and the nine other files of the full tier's failure list (`mcpConnectionFactory`, `acceptInvitation`, `mailServerSettingsStore`, `mailThreadBackfillCli`, `mailThreadAliases`, `agentRunsThreadMigration`, `mailDraftsStore`, `migrationCompatibility`, `transcriptionTask`). Both repaired files passed, as did all eight load files. No test ended in a 30 s timeout or a statement timeout, so no file was run a second time. No test was edited at landing and no timeout was raised.

Record checks, run on the merge commit with this receipt in the tree: `node .github/scripts/issues.mjs validate` and `node issues/batches/backend/verify.mjs`. `issues.mjs validate` exited 0 with an empty `errors` list (its "Model tier: missing" notes on old records are not errors), and `verify.mjs` exited 0 (673 sources, 74 main batches, 2 held batches). Logs: `records-validate.log` and `records-verify.log` in the `land/` directory above.

## Not repaired and open

- Of the 2 real entries given to this repair, none is left unrepaired.
- The whole integration tier has not been run on the repaired tip. This receipt shows 11 files on the merged tree and nothing more. Whether the tier is green apart from the baseline is for the next full run to show.
- The baseline case of `mcpConnectionFactory.test.ts` still fails on this host. It is not part of this repair.
- The eight load entries (`acceptInvitation`, `mailServerSettingsStore`, `mailThreadBackfillCli`, `mailThreadAliases`, `agentRunsThreadMigration`, `mailDraftsStore`, `migrationCompatibility`, `transcriptionTask`) were not repaired and nothing was changed for them. They passed alone after the full run and passed in this gate. They can fail again under the load of a full run.
- The tip named in the full tier's `result.json` (`2b356c00e`) is older than the tip of this repair (`65aa8a274`). The one later commit (ESLint heap limit, two realtime NOTIFY assertions) is not part of what the tier tested; no failure of it is known, and none is claimed.
- The test of `sempTurnReadAllowances` uses the literal redaction marker, not the exported constant (reviewer's nit).
- Other stale patterns were searched by the worker and the reviewer only; the queue runner did not repeat the search. The full run found no other failure of these two kinds.
- No source record, handover or manifest entry is changed by this repair. gh-1827 and gh-1812 stay as they were completed.
- The branch `repair/redacted-read-text-and-tenant-table-count` is kept. Its worktree is removed once this receipt is committed. Nothing is pushed.

## FAIL, BLOCKED and NOT RUN

- FAIL: the known baseline case of `mcpConnectionFactory.test.ts` in the targeted integration run. No other gate step and no other test of this landing failed.
- BLOCKED: none.
- NOT RUN: the whole integration tier on the repaired tip.
- NOT RUN: `install --frozen-lockfile`, `run check:pi-import-paths`, `check-migration-numbering` and `run test:e2e`.
- NOT RUN at landing: the worker's baseline runs of the unrepaired files and its scratch mutations. They are the worker's evidence; the queue runner read its record only.
- NOT RUN by the reviewer: any build or test.
- NOT RUN: anything against a deployed server or a production or staging database. Every test ran against the embedded test Postgres.
