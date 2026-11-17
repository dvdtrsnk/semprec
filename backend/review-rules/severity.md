- **critical** — data loss, security vulnerability (injection, auth bypass, leaked
  secret/credential, cross-tenant access), or a change that silently corrupts persisted state.
- **high** — a bug that breaks the feature the issue asked for, a missing input
  validation at a boundary the choke-point API exposes, a violation of the issue's
  "Out of scope" section, a permission check tested on one side only, an isolation
  test that bypasses RLS; a `review-rules/` rule or task weakened or dropped without
  the Task asking for it, a scope pattern that drops or cannot match its files, or a
  platform left with no task.
- **medium** — a bug confined to an edge case; an inconsistency with an established
  pattern elsewhere; a new behavior or acceptance criterion with no test; code that contradicts `docs/architecture/` without updating it; an added
  comment carrying an issue number, changelog narration or an ADR citation; a new
  backend ADR; contradicting or factually wrong `review-rules/` content.
- **low** — style, naming, a small missed simplification, a docstring on a
  self-explanatory function, a defensive guard for a state the types exclude.
- **Not findings** — a branch without its own test, an untested defensive branch, a
  missing docstring, no ADR or architecture entry for a local pattern.
- **Moved code.** In a verbatim move the Task requires, a non-critical defect in a line
  the diff moves unchanged (`git diff --color-moved`) is pre-existing: at most **low**,
  never blocking. Critical defects keep their severity; anything the move changes
  (imports, exports, signatures, check order, behavior) is reviewed normally.
