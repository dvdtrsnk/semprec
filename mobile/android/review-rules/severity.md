- **critical** — data loss, a security vulnerability (a secret, credential,
  keystore or signing configuration committed; an exported component without
  protection; backups or device transfer enabled for app data), a `!!`,
  unchecked cast or `requireNotNull` that untrusted input can reach, or a
  change that silently corrupts persisted state.
- **high** — a bug that breaks the feature the issue asked for; a feature that
  depends on another feature or on the app; a shared ViewModel created outside
  `koinViewModel`; a second Android ViewModel, or screen code, re-deriving
  shared state; effects collected so that navigation runs while the screen is
  stopped or runs twice; a navigation command replayed after
  recreation or lost; screen work in `GlobalScope` or holding an `Activity`;
  cancellation shown as an error; or a violation of the issue's own "Out of
  scope"; a `review-rules/` rule or task weakened or dropped without the Task
  asking for it, a scope pattern that drops or cannot match the files it
  intends, or a platform left with no task.
- **medium** — a bug confined to an edge case; new behavior without a test; a
  `ScreenLayout` that takes a ViewModel, Koin or a router, or a new layout
  without a preview; hard-coded user-facing text or a string without its Czech
  translation; exposed mutable state in a native ViewModel; a `!!`, unchecked
  cast or `requireNotNull` on a boundary value in test code; an unexplained
  `@Suppress` or a relaxed lint check; behavior that differs from the Apple
  app for the same shared state; an inconsistency with an established pattern
  elsewhere in the codebase; contradicting or factually wrong `review-rules/`
  content.
- **low** — style, naming, a comment that would help, a small missed
  simplification.

Critical, high and medium all block the merge (`REVIEW_BLOCK_SEVERITY: medium`
in `.github/workflows/code-review.yml`); low does not.
