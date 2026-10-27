# Scoped export contract, version 1

The exporter must use the approved repository access and emit a complete,
all-state export. A bounded single-page issue listing is not an export. Follow
every REST link or GraphQL cursor, checkpoint progress, honor rate-limit reset
and retry-after headers, and fail on truncation. Do not include credentials,
request authorization headers, PRs as issues or unrelated repositories.

`manifest.json`:

```json
{
  "schemaVersion": 1,
  "repository": "dvdtrsnk/semprec",
  "state": "all",
  "complete": true,
  "exportedAt": "2026-10-27T12:00:00.000Z",
  "issueCount": 1,
  "openCount": 1,
  "closedCount": 0,
  "issues": [
    { "number": 1, "path": "issues/1.json", "sha256": "<SHA-256 of exact file bytes>" }
  ]
}
```

Every issue bundle contains the original REST issue (`issue`), `comments`,
`events`, `subIssues`, `closedByPullRequests`, `attachments` and `collections`.
All collections are arrays; all coverage entries have `complete: true` and an
exact `count`. The required coverage keys are `comments`, `events`, `subIssues`
and `closedByPullRequests`. An inaccessible collection must fail export instead
of being represented as an empty complete collection.

The importer compares comment and child counts with the issue's `comments`
and `sub_issues_summary.total`, checks parent/child consistency, file hashes,
identity, repository and final state counts. The exporter's completed pagination
remains part of the trust boundary: a count alone is not proof that GitHub was
fully traversed. Save pagination evidence with the export for audit.

`subIssues` entries require `number`. `closedByPullRequests` must come from
GitHub's authoritative closing references, not branch names or body matching.
For each merged closing PR include `number`, `body`, `merged_at` and
`merge_commit_sha`. Include every available merged closing PR, not just one.

Comment records use GitHub's `id`, `user` (or null), `created_at`, `updated_at`,
`html_url` and `body`. Export events as returned, retaining their identity and
authorship. Do not claim to reconstruct deleted comments or prior body edits
that GitHub no longer exposes.

Attachments have an original `url` and one of:

- `status: "downloaded"`, a safe `filename`, relative `path`, and `sha256`.
- `status: "unavailable"`, with an explicit `reason`.

Paths must stay inside the export directory, including after symlink resolution.
JSON bundles are capped at 20 MB, individual attachments at 64 MB, and total
import payload at 200 MB. Exceeding a bound requires an explicit design update,
not silent truncation. Asset links remain in the original Markdown; local
copies and exceptions are recorded separately.

## Collection checkpoints

The scoped Access Hub adapter exposes stable all-state issue pages, complete
bounded history batches, paged fallbacks for large discussions and batched
authoritative closing-PR descriptions. The collector stores original issue
pages and explicit terminal-page evidence in its export cache. No GitHub token
is returned to the collector or placed in the repository.

`assemble-export.mjs <cache-directory> <export-directory> <exported-at>` verifies
the cache before creating the import envelope. It requires closing-reference
coverage for every issue, complete history, comment/child count agreement and
explicit attachment coverage. The source pagination evidence and the exact
export manifest checksum are retained in the repository migration manifest.

Timeline cross-reference events contain duplicate **current** issue and
repository snapshots. Their references retain identity, title, URL, state and
`bodySha256`; full issue bodies are stored separately in the issue catalog.
Comment bodies and other event payloads remain intact. Both batched normalized
events and raw paged fallbacks are normalized identically during assembly.
