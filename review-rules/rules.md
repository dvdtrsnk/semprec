- ADR filenames are `YYYY-MM-DD-kebab-case-slug.md`; no sequential numbering. A renamed
  or moved existing ADR file, or a new ADR with a numeric-prefix filename, is a
  high-severity finding — it defeats the whole reason this convention exists (see
  `docs/adr/README.md`): avoiding renumbering churn and merge collisions between
  parallel PRs.
- Every ADR has frontmatter with `status`, `date`, `area`, `supersedes`, and
  `superseded-by` — missing or malformed frontmatter is medium severity.
- Superseding a decision never rewrites the old ADR's Context/Decision/Consequences —
  only its frontmatter (`status: superseded`, `superseded-by: <new-slug>`) changes; the
  new decision gets its own new ADR with `supersedes: [<old-slug>]`. Editing an old
  ADR's body to reflect the new decision is a high-severity finding: it destroys the
  historical record an ADR exists to preserve.
- No hand-maintained index or listing file under `docs/adr/` (beyond `README.md`,
  which documents the convention, not the decisions) — it reintroduces the
  merge-conflict/staleness problem the flat, unindexed layout exists to avoid. Medium
  severity if one appears.
- An ADR should exist for a decision that shapes future code and had a real
  alternative; flag (low) an ADR written for a plain hygiene rule with no real
  alternative (e.g. "never log secrets") — those belong in a platform's
  `review-rules/rules.md`, not `docs/adr/`.
- A skill or rules file that restates an existing ADR's rationale at length instead of
  linking to it (`docs/adr/<slug>.md`) is low severity — the ADR is the source of
  truth for "why," the skill/rule should point to it.
