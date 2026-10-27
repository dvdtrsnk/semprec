---
status: accepted
date: 2026-10-27
area: [cross-cutting]
supersedes: []
superseded-by: null
---

# Repository issues retain canonical ids while Relay uses checked numeric aliases

## Context

[[2026-10-27-repository-markdown-issues-with-a-guarded-cutover]] moves issue
authority into Git. Relay's existing run store, reservations and workflow
subjects use positive numeric issue identities. Replacing those persisted keys
throughout Relay would also affect unrelated GitHub and GitLab projects.
The repository's protected integration branch accepts changes through reviewed
PRs; updating Git files as if they were individual GitHub labels would create
many metadata PRs and repeated rebases.

## Decision

Markdown ids remain canonical. Imported `gh-N` records use numeric alias `N`.
A new `sp-<UUIDv4>` uses `1000000000 + (first eight SHA-256 hex digits of its
complete id, interpreted as an unsigned integer, modulo 1000000000)`.
Aliases are compatibility keys, not user-facing ids, allocated issue numbers
or globally unique identifiers. Build the alias index from the complete
catalog and fail closed on any collision or value beyond Relay's existing
signed-integer range. Never silently assign another alias to an existing id.

Repository readers preserve original issue bodies. Relay interprets local
references and explicit `Repository-Issue: <id>` PR linkage using the same
alias contract; a new local issue must not produce a GitHub `Closes #<alias>`
instruction. Local authority must fail closed rather than fall back to GitHub
issue reads when a record or its approval is missing.

Completion is proposed in the implementation branch and becomes authoritative
only when that branch's reviewed changes reach the integration branch. The
target completion record carries local handover context and any PR reference
already known; the PR itself must carry the canonical issue id;
its implementation commit identifies the code proposal, not the still-unknown
future squash/merge commit. The actual delivery commit is available from Git
history after merge. A prepared completion file in an unmerged feature branch
does not unblock the scheduler reading the integration branch.

Runtime reservations, progress logs and technical retry/park state belong to
Relay's durable execution journal, scoped to the project, canonical issue and
specification revision. They do not require a Git commit for every pickup note
or label transition. Specification approval, queue intent, dependency graph and
delivered result remain in reviewed Markdown. The adapters, execution snapshots and runtime journal must be deployed before
activating repository authority; the read protocol alone does not implement
that lifecycle.

A harvest's ledger PR uses `Repository-Harvest: <id>` and the declared unlinked
model tier: its payload is exempt from implementation model-tier metadata. The
local source identity is still frozen for fixed-tier review runs. The harvest
stays open until merge; its explicit PR marker holds duplicate triage dispatch.

## Consequences

Existing run keys remain compatible, and a hash collision stops affected work
instead of confusing two issues. New issues need no shared counter. Completed
specifications and code travel together through the existing review and test
gates. Operators use canonical ids; numeric aliases remain an internal bridge.

The scheduled maintenance tasks use a reviewed metadata PR as well. One pending
maintenance PR holds further scheduled mutations. Epic completion observations are
versioned with the issues, including child membership and the observation time;
changing membership or opting out withdraws the observation. Harvest markers in the
versioned ledger replace new remote issue labels after cutover. Proposed follow-ups
and their harvest closure merge together, keeping backpressure visible until then.
