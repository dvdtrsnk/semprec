- One codebase, two targets: shared code lives outside any `#if os(iOS)` /
  `#if os(macOS)` branch unless the platforms genuinely need different
  behavior — a platform check used where a shared abstraction would do is a
  finding, not a style nitpick.
- No new abstraction, helper, or config flag beyond what the current issue's
  Zadani asks for — flag speculative generality the same way the project's
  own contribution guidance treats it: a smell, not a virtue.
- State that talks to the backend goes through a single networking/API layer
  — no view or view model opening its own `URLSession` request inline.
- Secrets, tokens, and credentials never appear in a log call, a committed
  file, or hardcoded in source — use Keychain for anything sensitive at
  rest.
- SwiftUI views keep `body` scannable: extract multi-line or nested sections
  into `private extension` subviews rather than growing `body` itself.
