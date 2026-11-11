---
status: accepted
date: 2026-11-10
area: [cross-cutting]
supersedes: [2026-10-31-sequential-backend-delivery-batches]
superseded-by: null
---

# Deliver the remaining backend backlog in parallel through a serialized merge queue

## Context

[[2026-10-31-sequential-backend-delivery-batches]] executed the backend backlog
as 74 aggregate batches with one writer in one working tree. Batches 1-39 are
delivered. For batches 40-74 the owner asked on 2026-11-10 to merge the
remaining work into one program and implement it concurrently, keeping the
project's rules, security and tests.

The 306 remaining source records form a declared dependency graph of depth 96.
169 of its edges between open sources are not capability dependencies: the
source's own text marks them as `Shared-file ordering`, added so that two
issues never edit the same registry, manifest, route matrix or hook file at
the same time under Relay's pull-request flow. Without those edges the graph
is 13 levels deep. A read of every source against the code also found
prerequisites that the sequential order had hidden and that no `Blocked by`
line names.

[[2026-09-24-issue-batches-as-dependency-dags]] already makes concurrent work
the default and names the collision classes: shared registries and migration
ordinals. It relies on Relay's serialized pull-request merge. This program runs
locally, so it needs its own queue.

Measurements on the delivery host bound the design: one full integration tier
takes 16 minutes as four shard processes and produces load timeouts when a
second full run overlaps; a targeted integration run costs 6-10 seconds; the
host can hold a limited number of embedded Postgres instances at once.

## Decision

**Unit.** The source record `issues/items/<id>.md` is the unit of approval,
review, acceptance evidence and guarded completion. A worker branch, called a
chain, carries one to four sources of one code area in dependency order. Each
source is one contiguous commit segment on that branch. A chain lands as one
merge, so its sources land together or not at all.

**Branch and writers.** The integration branch is `feature/backend-parallel`,
cut from `origin/develop` at `745aea3f6fe9cef26cb2260843e52eae5dd5e315`. Each
chain is implemented in its own Git worktree on its own branch
`chain/<key>`, created from the integration tip. At most six chains are
implemented at the same time. The integration worktree has one writer, the
queue runner: it performs every merge, every issue-record mutation and every
catalog read that a landing decision depends on, one landing at a time.
Workers do not edit issue records, do not run `approve` or `complete`, and do
not push. Worker claims live in the controller's ledger outside Git, because
the record reservation in
[[2026-10-27-repository-markdown-issues-with-a-guarded-cutover]] does not span
worktrees.

**Two edge classes.** The `Blocked by` lines are not edited. A blocker that
the source's own text marks as `Shared-file ordering` gates landing only: the
dependent source may be implemented concurrently and is merged after the
earlier one. Every other blocker is a capability edge and gates the start. At
landing, every declared blocker of every member, of both classes, is closed
as completed with a handover on the integration tip, or is an earlier member
of the same chain. Each integration commit therefore honours the whole
declared graph. The controller may add a start constraint or a mutual
exclusion between sources, for example for a hidden prerequisite or for two
sources that rewrite the same function. It does not remove a declared edge.

**Landing gate.** A chain is merged with `git merge --no-ff` only when all of
this holds for the exact candidate commit:

- Each source's segment was reviewed by contexts other than the one that
  implemented it: two reviewers, and a third security reviewer for a source
  that touches authentication, secrets, a public route, destructive data
  changes or agent approval. Findings are checked against the code before
  any fix. There are at most two review rounds: one complete review and one
  focused recheck of the fix. No source completes with an unresolved finding
  of medium severity or higher, or with an unmet explicit Task step or
  acceptance criterion.
- Each acceptance criterion has one evidence row with its test and one of
  PASS, FAIL, BLOCKED or NOT RUN. A criterion that needs a live provider or
  production stays NOT RUN and open, as
  [[2026-11-03-local-development-continues-with-open-production-gates]]
  requires.
- On the merged tree these pass: lint, format check, build, the unit tier,
  the static checks of `pnpm run verify`, the end-to-end tier, the validating
  suites of every shared registry file the merge touched, and every
  integration test file the chain added or changed.

Then the queue runner completes each member with the existing guarded
`issues.mjs complete`, one handover and one acceptance receipt per source
under `issues/batches/backend/acceptance/sources/`.

**Full integration tier.** The whole integration tier runs on the integration
tip as four shard processes after every eight landed chains and before every
publication. Only one full run is active on the host. A file that fails in the
sharded run is run again alone; a failure that reproduces alone stops further
landings until it is fixed or its chain is reverted. A file that fails under
shard load and passes alone is recorded as a load failure with both logs. It is
not reported as a pass of the sharded run. Timeouts are not raised.

**Shared files and migrations.** A conflict in a registry, barrel, manifest,
catalog or inventory test is resolved by keeping both sides and then running
that file's validating suites. A migration ordinal is final only at landing:
when a chain's ordinal collides with, or is not above, the highest ordinal on
the tip, the queue runner renames only that chain's own unmerged migration
files and their references on the chain to the next free ordinals and runs
`check-migration-numbering` and those migrations' tests again. A merged
migration is never renumbered.

**Records.** Original source records, their feature-epic parents, their
`delivery:` routing labels and the checked manifest stay. A source is never
cancelled or completed falsely. Source approvals are per exact hash and are
not inherited; a spec correction needs a recorded decision and a new approval.
The 35 aggregate records of sequences 40-74 are withdrawn: closed as
`not_planned`, never approved and never completed. Their manifest entries get
status `merged` and remain routing groups. `issues/batches/backend/verify.mjs`
accepts that status and, for it, no longer requires the aggregate body to embed
its members' snapshots; hashes, routing, dispatch suppression and dependency
order are still checked. A preparation issue that the program needs is a new
approved record and a manifest member. The two held client records and
gh-1086 are unchanged and outside this program. Scope stays backend only.

**Supervision and publication.** The controller is the BB thread that runs
the program under the owner's instruction of 2026-11-10. It replaces, for
sequences 40-74, the single-writer, one-branch-per-batch, named-model and
archive-then-next-worker sentences of
[[2026-10-31-owner-delegated-backend-program-supervision]] and the
single-writer sequence and structural-validator clauses of
[[2026-11-03-local-development-continues-with-open-production-gates]]; the
rest of both stays in force. Workers and reviewers run on the controller's
session model. The owner authorized pushing the integration branch and opening
a draft pull request against `develop` at checkpoints of about fifty landed
sources. Merging into `develop`, deploying, and any production or provider
action are not part of this decision.

## Consequences

Sources that share no capability dependency and no function are built at the
same time, so wall-clock time follows the longest dependency path and the
six-chain limit instead of the sum of all work. Total model usage rises,
because each chain pays for its own context and its own reviews.

A chain lands atomically. One member that fails review holds the other
members of its chain until it is fixed or the chain is cut before it.

Seventy-eight sources name `routeMatrix.ts` in `Touches`. The preparation
issue splits that file, so their entries go to its slice modules; the
preparation issue's handover says where.

Correctness of a merge in a shared registry now depends on the validating
suites, not on the absence of a Git conflict. The landing gate and the
periodic full tier are what catch a wrong merge; a defect that only the full
tier can see is found up to eight chains late and is then traced to its chain.

The start constraints the controller adds are not in the records. A later
program that reads only `Blocked by` lines would not see them.
