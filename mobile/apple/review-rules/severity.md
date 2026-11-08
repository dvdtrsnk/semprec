- **critical** — force-unwrap or force-try on a value that can genuinely be
  nil/throw at runtime (not a provably-safe unwrap), a security vulnerability
  (credential in source, disabled ATS/TLS validation, the macOS App Sandbox
  removed), or a change that silently corrupts persisted/synced state.
- **high** — a bug that breaks the feature the issue asked for, a retain cycle in a
  closure capturing `self` across an async boundary, UI state mutated off the main
  actor, or a violation of the issue's own "Out of scope"; a feature importing
  `SharedSDK`, another feature or the app; a screen model created outside the
  screen's `@StateObject` autoclosure; a CoreKit bridge that never closes its
  lease or closes it twice; an effect lost or delivered twice; a feature owning
  navigation state; cancellation shown as an error; a task that keeps working
  after its screen is gone; code that compiles for one of iOS and macOS only
  (the iOS-only XCUITest bundle `SemprecUITests` excepted); a
  `review-rules/` rule or task weakened or dropped without the Task asking for
  it, a scope pattern that drops or cannot match the files it intends, or a
  platform left with no task.
- **medium** — a bug confined to an edge case, a missing preview for a new screen, or
  an inconsistency with an established pattern elsewhere in the codebase; new
  behavior without a test; a task or observation that outlives its screen
  while only waiting; hard-coded user-facing text or a string without its Czech
  translation; an unexplained `swiftlint:disable` or a relaxed `.swiftlint.yml`;
  behavior that differs from the Android app for the same shared state;
  contradicting or factually wrong `review-rules/` content.
- **low** — style, naming, a comment that would help, a small missed
  simplification, SwiftUI layout preferences.

Critical, high and medium all block the merge (`REVIEW_BLOCK_SEVERITY: medium`
in `.github/workflows/code-review.yml`); low does not.
