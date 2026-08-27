- **critical** — data loss, security vulnerability (injection, auth bypass, leaked
  secret/credential), or a change that silently corrupts persisted state.
- **high** — a bug that breaks the feature the issue asked for, a missing input
  validation at a boundary the choke-point API exposes, or a violation of the issue's
  own "Mimo scope" (implementing something explicitly deferred, or skipping something
  explicitly in scope).
- **medium** — a bug confined to an edge case, a missing test for new choke-point
  behavior, or an inconsistency with an established pattern elsewhere in the codebase
  (e.g. a new endpoint that doesn't go through the existing choke-point).
- **low** — style, naming, a comment that would help, a small missed simplification.
