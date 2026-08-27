- **critical** — force-unwrap or force-try on a value that can genuinely be
  nil/throw at runtime (not a provably-safe unwrap), a security vulnerability
  (credential in source, disabled ATS/TLS validation), or a change that
  silently corrupts persisted/synced state.
- **high** — a bug that breaks the feature the issue asked for, a retain
  cycle in a closure capturing `self` across an async boundary, UI state
  mutated off the main actor, or a violation of the issue's own "Mimo
  scope".
- **medium** — a bug confined to an edge case, a missing preview for a new
  screen, or an inconsistency with an established pattern elsewhere in the
  codebase.
- **low** — style, naming, a comment that would help, a small missed
  simplification.
