---
status: accepted
date: 2026-09-24
area: [cross-cutting]
supersedes: []
superseded-by: null
---

# Issue batches are a dependency DAG, not a strictly sequential chain

## Context

`.github/ISSUE_FORMAT.md` required every issue after the first in a batch to
list at least its in-batch predecessor on its `Blocked by:` line, and
`/define-behavior` decomposed every spec into "a strictly sequential chain of
issues" on that basis. Relay's `implement-issue` workflow respects that line
(`respect-blocked-by: true`) and can run up to its own `max-concurrent` issues
at once — but a batch built as a chain never has more than one of its own
issues eligible at a time, so that concurrency budget went entirely to
*different* batches while any one batch serialized itself regardless of
whether its issues actually depended on each other's code.

Most issues in a batch don't need each other. A batch that adds a schema
column, a choke-point method using it, and a client call hitting it is a real
chain — each step needs the previous one's code to exist. A batch that adds
five independent view-type renderers, or five independent notification
channels, is not: nothing about implementing channel B requires channel A's
PR to have merged first. The chain model forced the second shape to pay the
first shape's serialization cost for no reason, and reviewing a rebased PR
after every sibling's merge (`merge-pull-request`'s deterministic rebase) is
non-free — full re-review cost, repeated once per sibling merge.

The risk of removing the chain by default is collision, not correctness: two
issues implemented in parallel that happen to edit the same file produce a
rebase conflict (cheap — Relay's deterministic rebase plus its conflict-agent
step handles it) or, worse, a collision a rebase can't detect at all because
the files differ but the *meaning* collides (two branches each claiming
migration ordinal `0048`, two branches each appending an entry to the same
manifest array where the append is itself the conflict).

## Decision

An issue batch is planned as a dependency DAG. `Blocked by:` names a real
dependency only: a capability another issue's Task delivers that this one's
Task needs, or a shared-file overlap between two issues that cannot be split
apart (a hotspot collision — see below). It is never added by default just
because an issue is later in the batch. Two issues with no such dependency
between them are concurrently eligible, and Relay may implement them at the
same time up to `implement-issue`'s `max-concurrent`.

To make the "shared-file overlap" half of that decision checkable rather than
a matter of after-the-fact luck, every implementation issue now carries a
mandatory `## Touches` section (`.github/ISSUE_FORMAT.md`) listing the files
or narrow areas within a file its Task will create or modify.
`/define-behavior` Phase 4 gets a mechanical decomposition step: for every
pair of issues that could be eligible at the same time, their `## Touches`
must not overlap — an overlap is resolved either by adding a real `Blocked
by:` edge or by extracting the shared change (a registry entry, a shared
type, a migration) into an earlier issue both then depend on.
`.github/ISSUE_FORMAT.md` documents the hotspot files this repository has
actually collided on (migration ordinals, module manifests/registries, the
`index.ts` barrels, the `web/src/i18n` message catalogs) and the convention
for each, so decomposition and the Phase 5 audit (its C5 class) can check
against a known list rather than reinventing it per batch.

The batch title's `NN/MM` keeps its shape but changes meaning: it is the
issue's position in topological creation order (every issue after every
issue it's `Blocked by:`), not a promise about execution order.

## Consequences

- `implement-issue`'s Relay workflow `max-concurrent` needs to move from 2 to
  3 so a batch that decomposes into three independent issues can actually run
  all three at once, instead of the DAG shape existing on paper while the
  runner still gates it to two — `.relay/**` is a protected path, so this
  ships as a follow-up maintainer pull request, not in the one that adds this
  ADR.
- A batch that genuinely is one long chain (each step needs the previous
  step's code) still ends up with every issue `Blocked by:` its predecessor —
  the DAG model produces the old chain as one of its shapes, it just stops
  forcing that shape on batches that don't need it.
- The migration-ordinal hotspot already has a deterministic guard
  (`backend/packages/data/scripts/check-migration-numbering.mjs`, wired into
  the required `ci` job, #288) that fails a duplicate ordinal regardless of
  whether decomposition caught it first; `## Touches` and the decomposition
  check exist to avoid the collision (and the resulting rebase-and-renumber
  round-trip) rather than to duplicate that guard's job of catching it.
- `merge-pull-request`'s deterministic rebase plus its conflict-resolution
  agent step remains the actual conflict handler when two concurrently
  eligible issues do collide (correctly declared or not) — this decision
  reduces how often that path is exercised, it doesn't replace it.
