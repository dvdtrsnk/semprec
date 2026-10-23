This is the repository-root platform of the Semprec monorepo: cross-cutting
documentation and AI-agent workflow files that don't belong to `backend/`,
`apple/`, or `web/` specifically — those three have their own review-rules
and are reviewed independently.

In scope here: Architecture Decision Records (`docs/adr/`), the
autonomous-workflow skills (`.claude/skills/`), the agent instructions and
convention skills BB injects into every thread (`.bb/AGENTS.md`,
`.bb/skills/`), the root `README.md`, the GitHub Actions workflows
(`.github/workflows/`), the repository scripts (`.github/scripts/`), and this
platform's own `review-rules/`.
The `review-rules/` of `backend/`, `apple/` and `web/` are reviewed by those
platforms, not here: the review bot assigns each file to the platform whose
directory is the longest prefix of its path.
This platform reviews the quality and internal consistency of those
documents themselves (ADR format, convention discipline, skill
correctness), the merge gate the workflows define, and changes to the rules
the review itself enforces — it does not have visibility into `backend/`/`apple`/`web`
diffs in the same PR, so it cannot judge whether a code change elsewhere
needed a new ADR; that check is each platform's own responsibility (see
their `review-rules/rules.md`), using their own repo access to look at
`docs/adr/` directly.

Work is planned as a dependency DAG of GitHub issues, each fully
self-contained; an issue may be implemented in parallel with any other issue
it does not declare a dependency on (`.github/ISSUE_FORMAT.md`). A pull
request is expected to close exactly one such issue and implement only what
it describes.
