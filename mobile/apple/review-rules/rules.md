- One codebase, two targets: shared code lives outside any `#if os(iOS)` /
  `#if os(macOS)` branch unless the platforms genuinely need different
  behavior — a platform check used where a shared abstraction would do is a
  finding, not a style nitpick. Every target builds natively for iOS, iPadOS
  and macOS (not Mac Catalyst) from the same sources, except the XCUITest
  bundle `SemprecUITests`, which runs on iOS and iPadOS only because macOS
  XCUITest needs the Accessibility permission.
  (`docs/adr/2026-10-24-kotlin-multiplatform-below-native-mobile-ui.md`)
- No new abstraction, helper, or config flag beyond what the current issue's
  Task asks for — flag speculative generality the same way the project's
  own contribution guidance treats it: a smell, not a virtue.
  (`docs/adr/2026-09-10-no-speculative-generality-beyond-issue-scope.md`)
- State that talks to the backend goes through the shared Kotlin data layer,
  reached through the CoreKit bridges — no view, view model, CoreKit bridge or
  app code opening its own `URLSession` request or using another HTTP client.
  (`docs/adr/2026-10-24-mobile-backend-calls-through-shared-data-layer.md`)
- Secrets, tokens, and credentials never appear in a log call, a committed
  file, or hardcoded in source — use Keychain for anything sensitive at
  rest.
- SwiftUI views keep `body` scannable: extract multi-line or nested sections
  into `private extension` subviews rather than growing `body` itself.
- A PR that introduces a genuinely new architectural pattern not covered by an
  existing rule here or by an ADR must add one under `docs/adr/` (see
  `docs/adr/README.md` for the format) — a new cross-cutting pattern with no ADR
  and no rule covering it is a medium-severity finding.
- A finding needs evidence: the changed line, the caller, consumer or owner you
  read, and the concrete consequence; a name or keyword match alone is not
  evidence. When the task item names a rule ID, start the description with it
  (`SHARED-VM: …`). The three mobile platforms (`mobile/`, `mobile/android/`,
  `mobile/apple/`) use the same rule IDs, so one defect class reads the same on
  each of them and a fix can find its parallel copies.
- Only CoreKit's sources import `SharedSDK`, besides `CoreKitTests`, which
  builds Kotlin values to test the bridges' mappings; features, `DesignSystem`,
  `Dependencies` and the app, and their tests, see CoreKit's Swift value types
  and `ScreenModel` protocols, never a Kotlin type. A feature depends on CoreKit and `DesignSystem` only —
  never on another feature or the app. Business outcomes come from the shared
  ViewModels: Swift code formats, renders and handles platform UX, and does not
  re-derive validation, ordering or what a failure means.
  (`docs/adr/2026-10-24-kotlin-multiplatform-below-native-mobile-ui.md`)
- A feature's screen ViewModel is a `@MainActor final class … : ObservableObject`
  that republishes the state of `any <X>ScreenModel`, forwards intents and turns
  effects into calls on its injected routing protocol. It is created only
  inside the screen's `@StateObject(wrappedValue:)` autoclosure — the
  `<Feature>ScreenFactory` passes a `makeModel` closure down to it — so the
  Kotlin ViewModel behind it is created once per screen identity; not
  `@Observable` with `@State`, whose initial value SwiftUI evaluates on every
  view initialization. Observation runs in the screen's `.task`.
  (`docs/adr/2026-10-24-shared-screen-viewmodel-lifecycle-and-native-hosting.md`)
- Every CoreKit bridge holds a `SharedViewModelLease` and closes it in `deinit`
  and nowhere else. A bridge whose ViewModel has effects delivers them through
  `EffectQueue(collecting:)`, whose one collecting task lives as long as the
  bridge; a bridge whose effect type is `Nothing` returns a stream that
  finishes at once (`SharedDetailScreenModel`). States go through `relay`. The
  Kotlin–Swift mappings are internal static functions that `CoreKitTests`
  check branch by branch. Previews and feature tests use `ScriptedScreenModel`
  and never start the Kotlin runtime.
  (`docs/adr/2026-10-24-shared-screen-viewmodel-lifecycle-and-native-hosting.md`)
- Features declare routing protocols and the app implements them on the
  scene's `NavigationContext` and its NavigatorUI stacks; a feature never
  imports NavigatorUI, owns a navigation path or presents another feature's
  screen. Navigation state belongs to one scene, so two windows never share it.
  The scene view holds the root navigator in its `@State`; no closure handed to
  NavigatorUI captures the scene view, and the destination provider captures
  the composition weakly, because NavigatorUI keeps it in the root navigation
  state and a strong path back would keep a closed window's composition and
  Kotlin SDK alive.
  (`docs/adr/2026-10-24-app-owned-mobile-navigation-through-feature-routers.md`)
- Every user-visible string, accessibility labels included, comes from the
  module's `Resources/Localizable.xcstrings` (`Text("key", bundle: .module)`,
  `String(localized:bundle:)`), with a translated Czech value and the dotted
  key that the Android resource mirrors with `_`; a string with arguments uses
  `String(format: String(localized: …), locale: .current, …)` so its key stays
  that plain name. A failure maps `FailureKind` to its `failure.*` key and an
  unexpected failure (`nil`) to `failure.unexpected`.
  (`docs/adr/2026-10-24-mobile-copy-localized-natively-from-typed-state.md`)
- Accessibility identifiers come from the module's identifiers enum, with the
  same value the Android app gives the same element, so one UI test plan finds
  the same element on both apps; an identifier one platform cannot attach is
  documented where the identifiers are declared.
- Not findings on this platform: legitimate `@StateObject` ownership at the
  composition boundary; a feature ViewModel calling its injected router for an
  effect; platform-native sheets, back gestures and navigation chrome; a
  package declaring a lower minimum than the app (Tuist builds it with the
  app's); SwiftUI layout preferences (low at most); and SwiftLint's style
  output — formatting, whitespace, import order, naming and the `// MARK:`
  before an extension (`marked_extension`) — which the author's own SwiftLint
  run settles. That exclusion covers style only, never a defect a task item
  rates: a force unwrap, force try or force cast (`force_unwrapping`,
  `force_try`, `force_cast`) or an import of `SharedSDK` outside CoreKit
  (`kmp_framework_outside_corekit`) is still reported under its task item,
  naming the SwiftLint rule. CI runs these tools on changes under `mobile/`; a tool also
  reporting a rated defect does not make it a non-finding.
