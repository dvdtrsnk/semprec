- **critical** — XSS/injection vulnerability, a secret or credential leaked
  into client-side code, or a change that silently corrupts persisted
  state.
- **high** — a bug that breaks the feature the issue asked for, a missing input
  validation at a boundary the choke-point API exposes, or a violation of the issue's
  own "Out of scope"; a `review-rules/` rule or task weakened or dropped without the
  Task asking for it, a scope pattern that drops or cannot match the files it intends,
  or a platform left with no task.
- **medium** — a bug confined to an edge case, a missing test for new behavior, or an
  inconsistency with an established pattern elsewhere in the codebase; contradicting
  or factually wrong `review-rules/` content.
- **low** — style, naming, a comment that would help, a small missed
  simplification.
