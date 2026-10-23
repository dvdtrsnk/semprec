- **critical** — force-unwrap or force-try on a value that can genuinely be
  nil/throw at runtime (not a provably-safe unwrap), a security vulnerability
  (credential in source, disabled ATS/TLS validation), or a change that
  silently corrupts persisted/synced state.
- **high** — a bug that breaks the feature the issue asked for, a retain cycle in a
  closure capturing `self` across an async boundary, UI state mutated off the main
  actor, or a violation of the issue's own "Out of scope"; a `review-rules/` rule or
  task weakened or dropped without the Task asking for it, a scope pattern that drops
  or cannot match the files it intends, or a platform left with no task.
- **medium** — a bug confined to an edge case, a missing preview for a new screen, or
  an inconsistency with an established pattern elsewhere in the codebase;
  contradicting or factually wrong `review-rules/` content.
- **low** — style, naming, a comment that would help, a small missed
  simplification.
