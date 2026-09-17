Check the Architecture Decision Records this pull request touches, against
`docs/adr/README.md` and this platform's `rules.md`:

1. An existing ADR file renamed or moved, or a new ADR whose filename is not
   `YYYY-MM-DD-kebab-case-slug.md` (in particular one carrying a sequential
   number) — high severity. Other documents and agents reference an ADR by
   slug permanently, and numbering is what the flat layout exists to avoid.
2. The Context, Decision or Consequences of an ADR whose `status` was already
   `accepted` before this pull request, edited in any way — high severity,
   including a narrow carve-out or a scope clarification that is itself
   correct. A reversal or narrowing is a new file (`supersedes: [<old-slug>]`,
   or a standalone ADR cross-referencing the old one when it only carves out
   an exception); the old file's frontmatter alone may change.
3. Missing or malformed frontmatter — `status`, `date`, `area`, `supersedes`,
   `superseded-by` — or a `date` that does not match the filename, or an
   `area` that omits a platform the decision actually governs. Medium.
4. An ADR marked `superseded` with no `superseded-by`, or naming a slug that
   does not exist under `docs/adr/`. Medium — a dangling supersession leaves
   the reader with no way to find what replaced it.
5. A new hand-maintained index or listing file under `docs/adr/` beyond
   `README.md` — medium. Discovery is `ls` plus grepping `area`.
6. An ADR written for a plain hygiene rule with no real alternative — low,
   flag that it belongs in a platform's `review-rules/rules.md` instead.
7. An ADR that states a decision the diff visible to this platform
   contradicts — for example a filename or `area` its own body disagrees
   with. Medium. This platform cannot see `backend/`/`apple/`/`web` diffs, so
   do not infer anything about code from their absence.
