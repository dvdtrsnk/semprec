- **critical** — data loss, security vulnerability (injection, auth bypass, leaked
  secret/credential), or a change that silently corrupts persisted state.
- **high** — a bug that breaks the feature the issue asked for, a missing input
  validation at a boundary the choke-point API exposes, or a violation of the issue's
  own "Out of scope" section (implementing something explicitly deferred, or skipping
  something explicitly in scope); a `review-rules/` rule or task weakened or dropped
  without the Task asking for it, a scope pattern that drops or cannot match the files
  it intends, or a platform left with no task.
- **medium** — a bug confined to an edge case, a missing test for new choke-point
  behavior, or an inconsistency with an established pattern elsewhere in the codebase
  (e.g. a new endpoint that doesn't go through the existing choke-point);
  contradicting or factually wrong `review-rules/` content.
- **low** — style, naming, a comment that would help, a small missed simplification.
