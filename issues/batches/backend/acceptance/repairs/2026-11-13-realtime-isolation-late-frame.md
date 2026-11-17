# Repair receipt: realtime-isolation-late-frame

**Date:** 2026-11-13

A repair of the integration tip, as the section "Repairs of the integration tip" of `issues/batches/backend/CONTROLLER.md` describes. It brings one test in line with the asynchronous delivery of a document invalidation that the server already performed. It adds no behaviour, changes no production file and completes no source record.

- Repair branch: `repair/realtime-isolation-late-frame`, cut from `382d1faee6d6e13cb430d78fa06dc144b3259a0f`. The branch is kept; the repair worktree is removed.
- Integration tip before the merge (PRE): `382d1faee6d6e13cb430d78fa06dc144b3259a0f` on `feature/backend-parallel`, the base of the repair branch.
- Fix commit and candidate: `a6923e5f530149e44aea21b06a6e2d38c6d204c2` ("Set aside the own-tenant doc invalidation in the realtime isolation drains"), the only commit of the branch, with the trailer `Repair-Of: gh-1811 (69d0a19dd)`.
- Merge commit: `1f223562995a758c19c40faf10f0682bf24e0509` ("Merge repair realtime-isolation-late-frame", `--no-ff`, parents `382d1faee` and `a6923e5f5`). The receipt is committed on top of it as "Record the repair realtime-isolation-late-frame".
- Conflicts: none. The merge was automatic.
- Files changed: one test file under `backend/` (`git diff --name-only 382d1faee a6923e5f5` lists exactly `backend/services/semprec-api/src/__tests__/tenantIsolationRealtime.test.ts`; 40 insertions, 2 deletions). No production file, nothing under `issues/`.

## Failing test as the full tier reported it

The full integration tier ran on tip `382d1faee6d6e13cb430d78fa06dc144b3259a0f`; logs are in `/Users/davidtresnak/.bb/thread-storage/thr_hc2df5gf4u/run/e1/ci-2062`. That directory holds the install, build and shard logs of the isolation runs (`iso-1.log` to `iso-6.log`, `lock-fix.log`); the entry below is the controller's record of the failure (`realtime-isolation-late-frame-args.json` in the repairs directory), stated as it was given to the repair worker. The queue runner did not reproduce the failure.

| File (under `backend/`) | Test as reported | Failure as reported |
| --- | --- | --- |
| `services/semprec-api/src/__tests__/tenantIsolationRealtime.test.ts` | realtime isolation across two tenants (issue #1054) > outbound frames > invalidate: produced by its mapped case (the case: inboxCards scope, from the tick creating B card, which reaches B1 only; line ~1089) | On the hosted CI runner, in two different integration shards of the same pull request, `a1` and `a2` (the two sockets of tenant A) received one extra frame `{ kind: text, type: invalidate, body: { scope: doc, databaseId, docId, itemId, lastEditedAt } }` before the sentinel of this case, where the case expects `[]`. Six local runs of the file pass. |

## Causing source

- The frame is the doc invalidation of `docInvalidationThrottle.ts` and `resolveDocInvalidation` in `backend/packages/realtime/src/syncServer.ts`, landed in `745aea3f6` ("Integrate locally completed backend delivery batches 1-39 (#2054)"). The server sends it only after a separate lookup transaction, with a trailing re-read 1000 ms after the first one when the same doc was written again. The writer announces a doc update after its commit through a fire-and-forget `publishRealtimeMessage` on its own pooled connection (`docPersistence.ts`, `wireHooks.ts`). Nothing orders that frame against the sentinel of a later case.
- The test that exposed it is the scenario that gh-1811, commit `69d0a19dd` ("Broadcast inboxCards realtime invalidations after card changes"), added: "inboxCards scope, from the tick creating A's card and the confirm of it on A1" and the following B-card scenario. The confirm writes a page. Earlier binary-frame cases of the same file also write tenant A's fixture doc several times within a second. Which of the two writes produced the frame that hit CI cannot be told from the report; the repair covers both.
- The reviewer's nuance, recorded as found: `69d0a19dd` is a test-plus-production commit, but the production change it made (the inboxCards scope) is not what produces the doc frame. The frame comes from the throttle and the sync server of `745aea3f6`. gh-1811 is named in `Repair-Of` because it added the case that the late frame breaks. The cause is a test timing race, not a leak between tenants.

## What was changed in the test and how the worker showed it can still fail

`tenantIsolationRealtime.test.ts`:

- `TestSocket` gets `ownTenantId`, set in the one place `a1`, `a2` and `b1` are assigned (`reconnectAll`: `a1` and `a2` are tenant A, `b1` is tenant B).
- `drainUntil` drops a text frame `{ type: invalidate, body.scope: doc }` only after the admin pool confirmed that the item named by `body.itemId` belongs to the socket's own tenant. It returns every other frame, so a doc frame of another tenant, a frame without a string `itemId`, a missing item row and every socket without `ownTenantId` still fail the empty-list assertions. A drain whose predicate is the doc frame itself is unaffected, because the predicate is checked before the drop.
- The header comment is updated. No assertion was removed, skipped or loosened and no timeout was raised. No production change.

How the worker showed it can still fail (worker.json, scratch changes all reverted):

- The late frame was reproduced before the change: holding the `doc_update` publication with a scratch gate and releasing it at the start of the B-card case made the test fail at `a1.drainUntil(...)` with a doc frame of tenant A on `a1` and `a2`. The admin lookup of the frame's `itemId` returned tenant A. After the change the same gate passes, with the frame set aside on both sockets.
- Negative control: a scratch mutation of `syncServer.ts` sending doc invalidations to every tenant's sockets, plus a scratch write in tenant B's doc during the case, made the changed test fail (`expected [ { kind: 'text', ... } ] to deeply equal []`).
- The changed whole file passed four times in a row (70 tests each) for the worker.

The queue runner did not repeat the gate experiment or the mutation (NOT RUN); they are the worker's. The queue runner ran the whole file once on the merged tree (below).

## Reviewer

One reviewer from another context read the diff `382d1faee..a6923e5f5`. Verdict: **findings**, two, both low. The reviewer verified that the diff changes one test file, that the matcher `isDocInvalidation` matches only a text frame of type `invalidate` with `body.scope` `doc`, that no other test of the file asserts a doc-scope invalidation, positively or as absent, and that the wait-until-match helpers (`nextMatching`, `expectInvalidationInA`) already skip such a frame. The reviewer ran no tests, by instruction, so the worker's gate and negative-control results are cited, not reproduced.

Outcome of every finding. The controller rule ("Review") sends a cheap low finding or a speculative risk to a recorded follow-up; neither finding is a security or privacy defect, a data-loss risk, broken behaviour or an unmet Task step. The queue runner changes no test during landing, so neither finding was fixed here.

| # | Severity | Finding | Outcome |
| --- | --- | --- | --- |
| 1 | low | Strict `next()` consumers (`openDoc`, `watchRun`) still meet a late own-tenant doc invalidation. The repair sets the frame aside only inside `TestSocket.drainUntil`; `openDoc` (`expect(await socket.next()).toMatchObject({ kind: 'binary', docId })`) and `watchRun` (`expect(await socket.next()).toMatchObject({ type: 'agent:event' })`) read the first frame strictly. Cases that write tenant A's fixture doc are followed by cases that start with `openDoc(a1, ...)` or `watchRun(a1, ...)` on fresh sockets, and the trailing re-read 1000 ms later can reach `a1` in the window between connect and the strict `next()` (a few to tens of milliseconds per case). The reviewer read the code paths only and did not show that the window is hit. Suggested fix: read through a helper that sets the frame aside with the same `isDocInvalidation` plus `isItemOfTenant` check, or move the check into `TestSocket.next`; do not drop it for a socket without `ownTenantId`. | Not fixed, recorded as a follow-up (below). Open. The single failure the tier reported was in `drainUntil`. |
| 2 | low | `isItemOfTenant` trusts `itemId` alone. The server builds `itemId` and `docId` from one lookup, so a frame whose `itemId` is of the socket's tenant but whose `docId` is not would still be dropped. The worker's mutation (doc invalidations to every tenant's sockets) is caught, because the item then belongs to the other tenant; a production defect that mixes the `docId` of one tenant with the `itemId` of another is not what the test is named for. Suggested optional fix: select `docs.id = frame.body.docId` in the same admin query (`SELECT i.tenant_id FROM docs d JOIN items i ON i.id = d.item_id WHERE d.id = $1 AND i.id = $2`) and require both to match. | Not fixed, recorded as a follow-up (below). Open. A small gap in the test, not a hole in the isolation proof. |

## Landing gate

Run on the merged tree (`git merge --no-ff --no-commit`, before the merge commit) in the integration worktree, backend directory, with `npx -y pnpm@9.12.0`. Logs: `/Users/davidtresnak/.bb/thread-storage/thr_hc2df5gf4u/run/repairs/realtime-isolation-late-frame/land/`.

| Step | Result |
| --- | --- |
| `-r run build` | PASS (exit 0) |
| `run lint` | PASS (exit 0) |
| `run format:check` | PASS (exit 0, all matched files use Prettier code style) |
| `run test:unit` | PASS (exit 0; 207 files passed in the backend unit config, 4 files passed in `@semprec/block-model`) |
| `run check:write-safety` | PASS (exit 0, 112 unsafe writes and 13 leaked connects, all in the baseline) |
| `run test:repo-scripts` | PASS (exit 0, 637 of 637) |
| `run check:boundaries` | PASS (exit 0, no violations, 6327 modules) |
| `exec vitest run --config vitest.integration.config.ts services/semprec-api/src/__tests__/tenantIsolationRealtime.test.ts` (the repaired file, which is also the only file of the failure list) | PASS (exit 0; 1 file, 70 tests passed, 5.9 s). Run once. |
| `node .github/scripts/issues.mjs validate` (after writing this receipt) | PASS (exit 0, `errors: 0`, 1462 records counted, 472 historical) |
| `node issues/batches/backend/verify.mjs` (after writing this receipt) | PASS (exit 0; 675 sources, 74 main batches, 2 held batches) |

## Not repaired and stays open

- Reviewer finding 1: `openDoc` and `watchRun` of `tenantIsolationRealtime.test.ts` read the first frame strictly and can still meet a late own-tenant doc invalidation. Follow-up: route them through the same set-aside check (or move it into `TestSocket.next`). It was not shown to fail.
- Reviewer finding 2: `isItemOfTenant` checks `itemId` only; an optional join on `docId` would make the set-aside stricter.
- `packages/data/src/__tests__/mcpConnectionFactory.test.ts`, case "gives the child exactly the inherited names, the config's env names and the credential name": the known baseline failure of this macOS host. It was not touched and not run by this repair.
- The failure was seen on hosted CI runners only; six local runs of the file passed before the repair. The queue runner ran the repaired file once and the worker four times; a pass does not prove that the race is gone on a loaded runner. The worker's gate experiment is the evidence that the late frame is set aside.
- The full integration tier was NOT RUN again on the merged tip; only the repaired file was run.
- The end-to-end tier and `pnpm run verify` as a whole were NOT RUN; only the static checks listed above were.
- Mutation checks of the test were not repeated by the queue runner (NOT RUN); they are the worker's.
