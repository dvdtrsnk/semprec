This is the repository-root platform of the Semprec monorepo: cross-cutting
documentation and AI-agent workflow files that don't belong to `backend/`,
`apple/`, or `web/` specifically — those three have their own review-rules
and are reviewed independently.

In scope here: Architecture Decision Records (`docs/adr/`), the
autonomous-workflow skills (`.claude/skills/`), and the root `README.md`.
This platform reviews the quality and internal consistency of those
documents themselves (ADR format, convention discipline, skill
correctness) — it does not have visibility into `backend/`/`apple`/`web`
diffs in the same PR, so it cannot judge whether a code change elsewhere
needed a new ADR; that check is each platform's own responsibility (see
their `review-rules/rules.md`), using their own repo access to look at
`docs/adr/` directly.

Work is tracked as a strictly sequential queue of GitHub issues, each fully
self-contained. A pull request is expected to close exactly one such issue
and implement only what it describes.
