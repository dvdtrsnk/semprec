# Repository issues

Issues are Markdown records with stable identities and a small YAML metadata
header. The rollout is tracked in [`migration/state.json`](migration/state.json).
While its authority is `github`, the live Relay workflows still use GitHub;
the local CLI is available for preparation and shadow evaluation. An empty
`items/` directory is not an imported backlog.

The decision and cutover requirements are recorded in
[`repository-markdown-issues-with-a-guarded-cutover`](../docs/adr/2026-10-27-repository-markdown-issues-with-a-guarded-cutover.md).
After cutover, issues and their dependency handovers must be read locally;
GitHub is used for PRs, review and CI, not as an issue-read fallback.

## Commands

Run from the repository root with Node 22 or later; no install is needed:

```sh
node .github/scripts/issues.mjs list
node .github/scripts/issues.mjs show gh-2035
node .github/scripts/issues.mjs ready
node .github/scripts/issues.mjs validate
node .github/scripts/issues.mjs create 'Implement the operation' /path/to/body.md
node .github/scripts/issues.mjs create 'Batch — epic' issues/templates/epic.md --kind epic
node .github/scripts/issues.mjs import /path/to/export --dry-run
node .github/scripts/issues.mjs import /path/to/export
```

`show` includes the exact file SHA-256. Mutations require that hash, so a
stale caller cannot overwrite a newer CLI update:

```sh
node .github/scripts/issues.mjs approve <id> <expected-file-sha256> <actor>
node .github/scripts/issues.mjs queue <id> <expected-file-sha256>
node .github/scripts/issues.mjs block <id> <expected-file-sha256>
node .github/scripts/issues.mjs reopen <id> <expected-file-sha256>
```

Creation produces an unapproved proposal. Approval requires the owner's
authorization; agents must not approve their own proposals. Actor metadata is
an audit annotation in a Git-reviewed file, not independent authentication.
Approving does not queue work. Queueing refuses protected paths declared in
`Touches`. Reopening clears queue intent; it does not silently redispatch.

`ready` is a local eligibility calculation, not an execution scheduler. It
performs no network calls, claims no work and does not dispatch Relay. Missing
dependencies, invalid specs, stale approvals, park labels, cancelled dependencies
and completed dependencies without handovers exclude an issue. `validate`
reports specification diagnostics and exits unsuccessfully if any are present;
import preserves such historical records rather than silently rewriting them.

## Record format

See [`schema.json`](schema.json) for metadata. Each frontmatter field has one
physical line, with its value encoded as JSON (a subset of YAML). Use quoted
strings, `null`, JSON arrays and JSON objects; do not use YAML aliases,
multiline values, comments or implicit types. The record envelope uses LF;
the body is preserved byte-for-byte, including any CRLFs it already contains.

`schemaVersion`, `id`, `title`, `kind`, `state`, `stateReason`, `labels`, `parent`,
`assignees`, `milestone`, `createdAt`, `updatedAt`, `closedAt`, `source`,
`approval` and `resolution` are required. The CLI serializes the complete header.

Imported identifiers are `gh-<GitHub number>`. New identifiers are `sp-<UUIDv4>`.
Do not rename a record or move it when closing it. A parent reference records
hierarchy; it is not a blocking dependency. Children are derived from parent
references, not maintained as a second list on an epic.

Implementation bodies follow [the canonical issue format](../.github/ISSUE_FORMAT.md).
`Blocked by` and `Model tier` occupy the first and second lines **of the body,
after the closing frontmatter delimiter**. Their values are not duplicated
in the frontmatter. Keep the original sections, scope, rationale and acceptance
criteria. Use comma-separated `#123`, `gh-123` or `sp-<UUIDv4>` dependencies;
`none` means no dependency. Epics cannot be implementation blockers.

Approval hashes the title, kind, parent and body. Changing those requires a new
approval before queueing. Labels and execution reservations are separate: files
record durable intent, while Relay owns live run coordination across worktrees.

## Import and history

An authorized exporter must supply the format in
[`migration/EXPORT_FORMAT.md`](migration/EXPORT_FORMAT.md). It must page every
collection, include open and closed issues, exclude PRs from the issue list,
and preserve authoritative closing-PR references. The importer does not obtain
credentials, make API calls or bypass Access Hub.

`history/<id>/source.json` is the immutable imported source, not the editable
spec. `history/<id>/comments/<comment-id>.md` preserves comment metadata and body;
`events.json` preserves available events. A handover contains the descriptions
of the verified merged closing PRs. Attachments keep original links in issue
bodies and local copies under `attachments/<id>/`; the migration report lists
missing assets. Downloading assets does not imply executing or trusting them.

Imports refuse changed destination files. Identical retries are safe, including
after interruption. The final `migration/manifest.json` records imported file
checksums, state counts and diagnostics. It does not itself activate local
authority. Final delta reconciliation must use a reviewed new snapshot before
cutover; rerunning the initial import over edited records is deliberately refused.

CLI writers reserve `items/.<id>.lock`. If a process crashes, inspect the owning
operation before removing its lock; never clear another agent's active lock.
Direct edits and independent worktrees are outside this reservation protocol.
