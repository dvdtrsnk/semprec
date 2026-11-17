- **critical** — an architecture document or ADR that misstates the architecture it
  documents in a way agents will execute (a wrong write path, ownership or isolation
  rule); a workflow change the linked issue's Task does not call for, or one that
  weakens or removes a required check; a `write` permission scope or a secret reachable
  by pull-request-controlled code in a workflow triggered by `pull_request_target`, or a
  move from an explicit `permissions:` block to the default token permissions (see
  `tasks/ci-workflows.md`).
- **high** — editing an accepted ADR's body instead of superseding it; renaming an ADR
  or reusing its slug for a different decision; a workflow permission wider than the
  job needs, a secret reachable by pull-request-controlled code (outside the
  `pull_request_target` cases above), an event expression inlined into a `run:` script,
  a pinned dependency unpinned, or a timeout/concurrency setting that can strand a
  required check; a `review-rules/` rule or task weakened or dropped without the Task
  asking for it, a scope pattern that drops or cannot match the files it intends, or a
  platform left with no task; in a repository script under `.github/scripts/`, a failed
  API call treated as an empty or successful result, a write performed in dry-run mode,
  or a token or other secret written to output (see `tasks/repo-scripts.md`).
- **medium** — history, issue numbers or a stale rule in `docs/architecture/`; a new
  ADR for a backend rule or a local pattern; an instruction that requires an ADR per
  pattern, a test per branch, a docstring per function or issue numbers in comments;
  missing ADR frontmatter, a sequential-looking ADR filename, or an index under
  `docs/adr/`; a workflow comment that no longer describes the YAML beside it;
  contradicting or factually wrong `review-rules/` content; in a repository script,
  external input used without being validated where it is read, a re-run-safety claim
  the order of its writes breaks, new decision logic whose behaviour no `node:test` test
  covers, or a comment that contradicts the code.
- **low** — wording, a document that could be more concise, a skill file that restates
  an architecture document instead of linking to it.
