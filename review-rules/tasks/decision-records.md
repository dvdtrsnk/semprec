Check the architecture documents (`docs/architecture/`) and ADRs (`docs/adr/`) this pull
request touches, against `docs/architecture/README.md`, `docs/adr/README.md` and this
platform's `rules.md`:

1. An architecture document that narrates history (what changed, when, in which issue),
   carries issue numbers or dates, or keeps a rule next to the one that replaced it —
   medium. It must read as the current rule set.
2. A statement in an architecture document that contradicts another architecture
   document, or a checkable claim (path, function, table, role) that is wrong — medium.
   This platform cannot see `backend/` diffs, so verify against the repository.
3. A new ADR for a backend rule or a local pattern — medium; it belongs in the relevant
   architecture document or in the code.
4. An existing ADR renamed or moved, or a new ADR whose filename is not
   `YYYY-MM-DD-kebab-case-slug.md` — high.
5. The body of an ADR that was `accepted` before this pull request edited in any way —
   high. A reversal is a new file with `supersedes: [<old-slug>]`; only the old file's
   frontmatter may change.
6. Missing or malformed ADR frontmatter, a `date` that does not match the filename, an
   `area` that omits a governed platform, or `superseded` without a resolvable
   `superseded-by` — medium.
7. A hand-maintained index under `docs/adr/` beyond `README.md` — medium.
