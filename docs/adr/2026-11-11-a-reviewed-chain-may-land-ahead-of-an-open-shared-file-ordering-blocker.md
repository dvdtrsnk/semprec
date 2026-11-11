---
status: accepted
date: 2026-11-11
area: [cross-cutting]
supersedes: []
superseded-by: null
---

# A reviewed chain may land ahead of an open shared-file-ordering blocker

## Context

[[2026-11-10-parallel-backend-delivery-through-a-serialized-merge-queue]] lets
a source start before a blocker that its own text marks as
`Shared-file ordering`, and requires at landing that every declared blocker,
of both classes, is completed. That rule kept every integration commit in the
declared order.

On 2026-11-11 the owner stopped further implementation in the program and
asked for all completed work to be merged into `develop`. At that point twenty
chains with twenty-five sources had passed review, the fix round and the
recheck. Five of those sources wait only for a shared-file-ordering blocker
whose own source is not implemented: gh-1697 for gh-1691, gh-1720 for gh-1702,
gh-1754 for gh-1724, gh-1764 for gh-1762 and gh-1836 for gh-1833. Fourteen
more are ordered behind gh-1697 and gh-1720. Under the landing rule these
nineteen sources could not land, although nothing they need is missing: every
blocker that is still open is marked as shared-file ordering in the text of
the source that names it.

A shared-file-ordering edge is not a capability dependency.
[[2026-09-24-issue-batches-as-dependency-dags]] introduced it so that two
issues do not edit the same registry at the same time under Relay's
pull-request flow. The merge queue of the parallel program already resolves
such an overlap by keeping both sides and running the validating suites of the
shared file.

## Decision

A chain may land when, for every member, each declared blocker is completed on
the integration tip or is an earlier member of the chain, with one exception:
a blocker that the member's own text marks as `Shared-file ordering` may still
be open. The queue runner decides this from the source text, not from the
controller's analysis, and the acceptance receipt of the member names every
blocker that was open when it landed.

The rest of the landing gate stays as decided: review by other contexts, the
evidence rows, the checks on the merged tree and guarded completion.

When the source of such a blocker lands later, it lands on top of the sources
that named it. It keeps both sides in shared registries. In a file whose entry
order is meaningful (`domainWriteHooks.ts`, `db/tenantCutoverMigrations.ts`)
its entries go before the entries of the landed sources that named it as a
blocker, which is where the declared order would have put them, unless its
Task names another position.

On the same instruction the integration branch is merged into `develop`
through a pull request after the whole integration tier ran on its tip, and
the program stops there. A source that is not landed stays open with its
approval and routing. Nothing is cancelled.

## Consequences

An integration commit no longer proves the whole declared graph. A completed
source can have an open declared blocker; its receipt says which.

The later source pays for the order. Its landing places ordered entries by
position instead of appending them, and its worker finds code in the tree that
the declared order said would come after it.

`issues/batches/backend/verify.mjs` is unaffected. It checks routing, hashes
and where a dependency sits in the manifest, not the order in which sources
are completed.
