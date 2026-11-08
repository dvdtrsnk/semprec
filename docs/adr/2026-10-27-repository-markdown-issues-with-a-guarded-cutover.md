---
status: accepted
date: 2026-10-27
area: [cross-cutting]
supersedes: []
superseded-by: null
---

# Repository Markdown issues replace GitHub issue storage after a guarded cutover

## Context

Issue discovery, dependency resolution and repeated reads of blocker PR bodies
consume GitHub API capacity. The owner approved migrating all issues, including
closed issues and epics, to repository files. A mirror alone would retain those
API dependencies. The new store must preserve the self-contained specification
and dependency DAG of [[2026-09-24-issue-batches-as-dependency-dags]] and the
model-tier contract of [[2026-10-08-issue-metadata-selects-relay-model-tiers]].

Current Relay subjects, review snapshots and the follow-up publisher still use
GitHub issue identities. [[2026-09-26-merged-review-findings-become-proposed-follow-up-issues]]
records GitHub labels and markers as the follow-up state store. That remains
the live contract until an explicitly verified cutover; adding local files
does not change the running scheduler's authority.

## Decision

Use `issues/items/<id>.md`, with schema-versioned YAML frontmatter and the
original issue body. YAML values use JSON syntax on one physical line per key;
this limits the parser to an unambiguous dependency-free subset. No aliases,
implicit scalar conversion, executable tags or duplicate keys are accepted.

Imported issues keep `gh-<number>` identities and source metadata. New issues
use `sp-<UUIDv4>`, avoiding a shared next-number counter. Files stay at permanent
paths when titles or states change. Existing `#N` dependency references resolve
to `gh-N`; new references can use either complete local identity. Dependencies
and model tier remain in the body, without duplicated editable YAML fields.

Import available comments and events under `issues/history/<id>/`, attachments
under `issues/attachments/<id>/`, and authoritative closing PR descriptions
under `issues/handovers/<id>.md`. Preserve original body bytes and metadata;
do not repair historical specifications during import. Report malformed specs,
missing relationships and unavailable attachments explicitly. Immutable raw
source records provide migration provenance and are not another editable spec.

The offline importer consumes a complete all-state, checksum-verified export
from an authorized scoped exporter. It validates coverage before writing and
refuses to overwrite differing local files. Its final manifest records the
generated files and diagnostics. Access or pagination failure is not evidence
of an empty collection. Deleted source content is not reconstructible.

Approval covers the title, issue kind, parent and exact body via SHA-256.
Changing any of those invalidates approval. Imported `spec:approved` labels
record GitHub-label provenance with unknown actor, without inventing a human
approval event. Approval and queueing are separate operations. Agents must
not approve their own generated proposals. Protected-path work stays manual.

Cooperating local CLI writers reserve one issue with exclusive directory
creation, check the expected file hash and replace the file by rename. A crash
can leave a reservation requiring human inspection; there is no automatic
stale-lock takeover. Direct editor writes do not participate in this protocol.
Git reconciliation and Relay's runtime reservations remain necessary across
worktrees; a repository label is not a distributed execution lock.

Keep `issues/migration/state.json` authoritative for the migration phase.
GitHub remains authoritative while `authority` is `github`. Cutover to
`repository` requires complete export and delta reconciliation, repository
validation, tested Relay/review/follow-up adapters, a shadow-frontier comparison
and accounting for in-flight work. These integration and cutover steps are
not implemented by the initial store alone. No automatic GitHub fallback is
permitted after cutover: missing local data must stop the affected work.

The target lifecycle confirms completion only after merge and persists the
closing PR identity, merge commit and local handover. A failed completion
write holds dependent work until reconciliation. A cancelled or rejected
dependency does not count as delivery. Existing completed imports require
their exported handover before they unblock locally queued implementations.

## Consequences

Local reading, parsing, approval, dependency selection and import are independent
of GitHub credentials. GitHub remains the host for PRs, reviews and checks.
Full runtime migration also requires changes in the separate Relay and review
integrations; no documentation-only declaration activates it. The migration
keeps existing GitHub issues as history and introduces no permanent bidirectional
sync. Rollback must account for local changes created since cutover before
restoring GitHub authority.
