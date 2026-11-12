---
status: accepted
date: 2026-11-11
area: [cross-cutting]
supersedes: []
superseded-by: null
---

# Chains may land as a train with one gate

## Context

[[2026-11-10-parallel-backend-delivery-through-a-serialized-merge-queue]] has
one queue runner land one chain at a time and run the landing gate on the tree
of that chain's merge. Measured over twenty-one landings, one landing takes
about twenty minutes, most of it the gate and the per-source records. Six
workers finish about five chains an hour, the queue runner lands about three,
so reviewed chains wait in the queue and the program moves at the speed of the
gate.

The gate's checks cost about the same whether the tree holds one new chain or
three.

## Decision

The queue runner may land up to three chains as one train. It merges them one
after another, each with its own `--no-ff` merge commit made after the build
passes on that merge. It then runs the landing gate once, on the tree that
holds every chain of the train, with the integration test files of all of
them and the validating suites of every shared file the merges touched. Then
it completes the members of every chain, with one handover and one receipt
per source as before.

If a merge cannot be resolved as a registry conflict, or a build or the gate
fails, the queue runner returns the integration branch to the commit it had
before the train, and the chains of that train land one at a time under the
single-chain rule. No merge of a failed train stays on the integration branch.
The return is a hard reset to that commit, and it discards only merge commits
that this landing created.

A chain that failed in a train is not put into another train.

Each receipt names the chains of its train and the commit whose tree the gate
ran on. The rest of the landing gate is unchanged: review by other contexts,
the evidence rows, the blocker rule and guarded completion.

## Consequences

The gate evidence of a chain is a pass on a tree that also holds the other
chains of its train, not on the tree of its own merge commit. A defect that
shows only without the later chains of the train is not seen by the gate; the
full integration tier and the pull request's CI run on later trees still
cover the code.

A failed train costs one gate run before its chains are tried alone.

The queue runner now has a command that discards commits. It is bound to the
commit recorded at the start of the landing and to commits the landing itself
created.
