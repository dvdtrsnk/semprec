# Parallel backend program controller

This is the working protocol for sequences 40-74 under
`docs/adr/2026-11-10-parallel-backend-delivery-through-a-serialized-merge-queue.md`.
The protocol that delivered batches 1-39 is in this file's Git history.

## Program state

The owner stopped the program on 2026-11-12: chains in flight were finished
and nothing new was started. 59 of the 310 sources of sequences 40-74 are
completed: 41 went into `develop` with pull request #2055, and 18 more were
landed after the program continued from `origin/develop` at `8d17af6e7`. The
other 251 sources stay open, approved and routed; a later program continues
from `develop` with this protocol.

Open and not to be started without a decision:

- `sp-5419cac1-f4a7-4717-b870-4f244b1ad166` (order of the edge-changed hooks
  and the value link break) is blocked under its Task step 2. Its worker
  found that the reorder removes the reported lock cycle and opens another
  one, between an edge write on `Transcripts.project` and the move of the
  transcript's Event to the Trash, and withdrew its change. The cycle the
  source describes is therefore still in the code since gh-1697.
- gh-1756 waits for that source.
- gh-1702 was refused at preflight: its Task allows only a rule declaration,
  and the link engine of gh-1593 unions the sources of a many-valued target
  and creates no link for a target that holds a value, which the Task
  presupposes otherwise.

Started and not finished, with nothing kept in the repository: gh-1778 and
gh-1765.

Controller: BB thread `thr_hc2df5gf4u`, on the owner's instruction of
2026-11-10. Scope is backend only. The integration branch is
`feature/backend-parallel`; "Program state" above names its current base.
The controller's own checkout is the integration worktree.

## Roles

- **Controller.** Plans waves of chains from the records and its ledger,
  starts one orchestration run at a time, reads the real artifacts when a run
  ends, and decides what happens to a held chain. It keeps the ledger of
  claims, added start constraints and mutual exclusions outside Git.
- **Worker.** Implements one chain in its own worktree on `chain/<key>`,
  created from the integration tip. One contiguous commit segment per source,
  in the chain's order. It loads `implement-issue` and the topic skills each
  Task names. It never edits `issues/`, never runs `approve` or `complete`,
  never pushes and never touches another worktree.
- **Reviewers.** Read one source's segment at the frozen candidate commit and
  write nothing in the repository. Two per source; a third security reviewer
  for a source that touches authentication, secrets, a public route,
  destructive data changes or agent approval.
- **Fixer.** Checks each finding against the code first, fixes the confirmed
  ones on the chain branch, answers the mistaken ones with a reason, and
  follows `fix-review-findings`.
- **Queue runner.** The only writer of the integration worktree. One landing
  at a time.

## Planning a wave

A source may start when every capability blocker is closed as completed with
a handover on the integration tip or is an earlier member of its chain, every
start constraint in the ledger is met, and no source in flight shares a mutual
exclusion with it. A blocker that the source's text marks as
`Shared-file ordering` does not gate the start, but it must be landed or part
of the same wave, so the dependent source never waits in the queue for work
nobody has started. At most six chains are implemented at once.

A chain has one to four sources of one code area. A source whose worker finds
that something its Task presupposes is missing is not improvised: the worker
reports the missing prerequisite, the chain ends before that source, and the
controller records the prerequisite as a start constraint.

## Worker checks

In the chain worktree, with the repository-pinned pnpm 9.12.0
(`npx -y pnpm@9.12.0`): install, build, ESLint and Prettier on the files it
changed, the unit and integration test files it added or changed, and every
test file that covers code it changed. It reports one evidence row per
acceptance criterion: criterion, test, PASS, FAIL, BLOCKED or NOT RUN. The
whole lint, unit tier and full integration tier belong to the queue runner,
because the host fits only a few of them at once.

## Review

One complete review per source and one focused recheck of the fix. After the
recheck the controller decides: a cheap low finding or a speculative risk goes
to a recorded follow-up; a security or privacy defect, a data-loss risk, broken
behaviour or an unmet explicit Task step or acceptance criterion holds the
chain. Correct code is not changed to satisfy a mistaken finding.

## Landing

For one chain, in this order:

1. The integration worktree is clean and on the integration branch. Every
   declared blocker of every member is closed as completed with a handover on
   the tip, or is an earlier member of the chain. A blocker that the member's
   own text marks as `Shared-file ordering` may still be open
   (`docs/adr/2026-11-11-a-reviewed-chain-may-land-ahead-of-an-open-shared-file-ordering-blocker.md`);
   the receipt names it. When that blocker's source lands later, its entries
   in `domainWriteHooks.ts` and `db/tenantCutoverMigrations.ts` go before the
   entries of the landed sources that named it.
2. `git merge --no-ff chain/<key>`. Conflicts in shared registries are
   resolved by keeping both sides. Migration ordinals that collide with, or
   are not above, the highest ordinal on the tip are moved to the next free
   ordinals; only the chain's own files and references change.
3. On the merged tree: lint, format check, build, unit tier, the static
   checks of `pnpm run verify`, the end-to-end tier, the validating suites of
   every shared file the merge touched (below) and every integration test
   file the chain added or changed.
4. If step 3 fails because of the merge, the merge is corrected. If it fails
   because of the chain's own code, the merge is abandoned, the integration
   branch returns to the commit it had before step 2 and the chain is held.
5. For each member in order: `issues.mjs complete` with the chain's candidate
   commit and an English handover, and an acceptance receipt
   `acceptance/sources/<id>.md` with the candidate commit, the merge commit,
   the review outcome, the evidence rows and every FAIL, BLOCKED and NOT RUN.
   Then `issues.mjs validate` and `verify.mjs`, and one metadata commit.

## Trains

The queue runner may land up to three chains as one train
(`docs/adr/2026-11-11-chains-may-land-as-a-train-with-one-gate.md`). It
merges them in order, each with its own merge commit after the build passes,
runs step 3 once on the tree that holds all of them, and then does step 5 for
every member. If a merge cannot be resolved as a registry conflict, or a
build or the gate fails, it returns the integration branch to the commit
before the train, and those chains land one at a time. Each receipt names the
train and the commit the gate ran on.

## Validating suites of shared files

- `backend/packages/data/src/index.ts`: `packages/data/src/__tests__/publicSurface.test.ts`
  (its expected export list is kept in JavaScript sort order).
- `routeMatrix.ts` and its slice modules, `ROUTE_CASES`, `ROUTE_HANDLER_FILES`:
  `routeMatrixInventory.unit.test.ts`, `chokePointWriteBoundary.unit.test.ts`,
  `routeMatrix.test.ts`, `tenantIsolationRoutes.test.ts` (whole file),
  `cacheControl.test.ts`, `adapterTenantScope.test.ts`,
  `bespokeListenerTenantScope.test.ts`, `adminHandler.test.ts`. A route entry,
  its isolation case and its handler-file mapping land in the same merge.
- `domainWriteHooks.ts` and `db/tenantCutoverMigrations.ts`: entry order is
  meaningful. Entries of a later source go after those of the sources it
  declares as blockers. Run `tenantCutoverMigrations.test.ts` and the tests
  of each hook the merge registered.
- Generic operations (`packages/shared/src/genericOperations/`):
  `operationCatalog.unit.test.ts`, `genericOperationsContract.test.ts`,
  `mcpGenericOperationsContract.test.ts`.
- Module manifests and i18n catalogs: the module registry and catalog tests
  of the owning module.

## Full integration tier

After every eight landed chains and before every publication the queue runner
runs the whole integration tier on the integration tip as four shard
processes (`vitest run --config vitest.integration.config.ts --shard=i/4`).
No other full run is active on the host at that time. Each failing file is run
again alone. A failure that reproduces alone stops further landings; a file
that passes alone is recorded as a load failure with both logs.

Known baseline of the delivery host: `mcpConnectionFactory.test.ts`, case
"gives the child exactly the inherited names, the config's env names and the
credential name", fails on macOS because the system adds
`__CF_USER_TEXT_ENCODING` to every child process. It is reported as FAIL in
every local full run and is not a result of this program. A different failure
of that file is not covered by this note.

## Publication

At checkpoints of about fifty landed sources, after a full integration tier
run, the controller pushes `feature/backend-parallel` and keeps one draft pull
request against `develop` open, so hosted CI runs the canonical pipeline. The
pull request body carries no `Repository-Issue:` line. Nothing is merged into
`develop` and nothing is deployed.

## Repairs of the integration tip

A landed chain can break a test outside its own landing gate, for example a
test that keys on the text of a statement the chain changed. The full
integration tier finds it. Such a failure is repaired before anything else
lands:

1. The controller names the failing tests and the source that caused them.
2. A repair worker fixes them in its own worktree on a branch `repair/<key>`
   cut from the integration tip. A repair restores what the causing source's
   Task already required to stay true, usually by bringing tests that keyed
   on the old behaviour in line with it. It adds no behaviour. A fix that
   needs a production change beyond the causing source's Task is not a
   repair: the causing chain is reverted, or a new source is written.
3. One reviewer from another context reads the diff.
4. The queue runner merges the branch with `--no-ff`, runs the landing gate
   with the repaired files, and writes
   `acceptance/repairs/<date>-<key>.md`: the failing tests, the causing source
   and commit, the fix commit, the reviewer's verdict and the gate results.
   A repair completes no source record.

## Decisions on held chains

A chain that the recheck or the landing gate holds waits for the controller.
A specification question is decided as the section "Autonomy" of
`issues/README.md` describes: a decision agent decides, an independent agent
challenges the decision, and the controller applies it. The decision record is
`issues/decisions/<id>.md`; a corrected record is approved again for its new
hash and its manifest member is updated. When the decision needs a code
change, the chain gets one more fix round and one focused recheck of that
delta; the receipt names the decision as the reason for the extra round.

## Open items

- gh-1086 stays open as the production release gate. The two held client
  records stay held.
- The Markdown parser of `shared/block-model` (`stripMarkdown`) takes
  super-linear time on unmatched markers. `issues/decisions/gh-1729.md`
  describes it. The Semp thread list bounds its input; authenticated write
  routes that parse a whole message do not. No source covers it yet.

## Reporting

BLOCKED and NOT RUN are reported as such. A file's presence is not evidence
of behaviour. A review that did not read a commit is not cited for it. A
process the controller or its agents did not start is not theirs to stop.
