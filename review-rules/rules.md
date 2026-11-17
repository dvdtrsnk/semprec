- Backend and cross-cutting architecture lives in `docs/architecture/`, updated in place.
  A document there states current rules only: changelog narration ("now", "previously",
  "after the cutover"), issue numbers, dates or a section kept for a rule the code no
  longer follows is medium severity — the next agent executes it as current.
- A new file under `docs/adr/` for a backend rule, or for a local pattern (one module,
  one operation, one lock order), is medium: it belongs in the relevant
  `docs/architecture/` section or in the code. A new ADR is for a mobile or web decision,
  or a genuinely new cross-cutting decision no architecture document covers.
- An instruction file or skill that makes agents produce process weight the repository
  rejects — an ADR per pattern, a test per branch, a docstring per function, issue
  numbers or ADR citations in code comments — is medium: it contradicts `.bb/AGENTS.md`.
- ADR filenames are `YYYY-MM-DD-kebab-case-slug.md`, never renamed or moved; a numbered
  or renamed ADR is high severity (other documents reference it by slug). Every ADR has
  `status`, `date`, `area`, `supersedes` and `superseded-by` frontmatter; missing or
  malformed is medium.
- Superseding an ADR never rewrites the old body; only its frontmatter changes and the
  new decision is a new file. Editing an accepted ADR's body is high severity.
- No hand-maintained index under `docs/adr/` beyond `README.md` — medium.
- A skill or rules file that restates an architecture document at length instead of
  linking to it is low: the second copy drifts.
