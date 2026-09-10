- One codebase, two targets: shared code lives outside any `#if os(iOS)` /
  `#if os(macOS)` branch unless the platforms genuinely need different
  behavior — a platform check used where a shared abstraction would do is a
  finding, not a style nitpick.
  (`docs/adr/2026-09-10-single-shared-swift-codebase-for-ios-macos.md`)
- No new abstraction, helper, or config flag beyond what the current issue's
  Zadani asks for — flag speculative generality the same way the project's
  own contribution guidance treats it: a smell, not a virtue.
  (`docs/adr/2026-09-10-no-speculative-generality-beyond-issue-scope.md`)
- State that talks to the backend goes through a single networking/API layer
  — no view or view model opening its own `URLSession` request inline.
  (`docs/adr/2026-09-10-single-networking-layer-in-apple-client.md`)
- Secrets, tokens, and credentials never appear in a log call, a committed
  file, or hardcoded in source — use Keychain for anything sensitive at
  rest.
- SwiftUI views keep `body` scannable: extract multi-line or nested sections
  into `private extension` subviews rather than growing `body` itself.
- A PR that introduces a genuinely new architectural pattern not covered by an
  existing rule here or by an ADR must add one under `docs/adr/` (see
  `docs/adr/README.md` for the format) — a new cross-cutting pattern with no ADR
  and no rule covering it is a medium-severity finding.
