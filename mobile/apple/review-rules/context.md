This is the `mobile/apple/` platform of the Semprec monorepo (the repository
root, `backend/`, `web/`, `mobile/` and `mobile/android/` are separate
platforms with their own review-rules and are reviewed independently).
`mobile/apple/` is one SwiftUI codebase that builds the Semprec app for iOS,
iPadOS and macOS — native macOS, not Mac Catalyst — from the same targets: one
app, all three, not separate projects. Every target uses
`SemprecProject.destinations` (`[.iPhone, .iPad, .mac]`) and
`SemprecProject.deploymentTargets` (iOS and macOS minimums from
`Tuist/ProjectDescriptionHelpers/ProjectConfiguration.swift`), builds for
arm64 only, in Swift 6 language mode with complete strict concurrency, with
Debug and Release configurations only. The one exception is the XCUITest
bundle `SemprecUITests`, which builds for iPhone and iPad only
(`.iOS(ProjectConfiguration.iosMinimum)`), because macOS XCUITest needs the
Accessibility permission, which build machines do not grant. Tuist, pinned in `.tuist-version`,
generates the projects and the `Semprec` workspace from `Workspace.swift`, the
`Project.swift` manifests and `Tuist/ProjectDescriptionHelpers/`; the packages
(Factory as `FactoryKit`, NavigatorUI) are pinned in `Tuist/Package.swift` and
`Tuist/Package.resolved`. `scope.md` includes every file under `mobile/apple/`
(`**`). Screen logic and business decisions come from the Kotlin `SharedSDK`
framework built from `mobile/shared/`, reviewed by the `mobile/` platform; this
app renders their state, maps their effects to navigation, owns the copy and
handles each platform's UI. The Android app in `mobile/android/` renders the
same shared ViewModels, so the two apps are expected to behave alike
(`tasks/parity.md`). The modules:

- `Modules/Core/CoreKit` — the only module whose sources import `SharedSDK`,
  and only in `Sources/Shared/` (as `@preconcurrency internal import SharedSDK`),
  so no Kotlin type leaves it; its test target `CoreKitTests` is the only other
  importer. Per shared screen it has Swift value types and a `ScreenModel`
  typealias (`Sources/Models/`), a bridge class
  (`Sources/Shared/Shared<X>ScreenModel.swift`) that maps Kotlin state, actions
  and effects with internal static functions (`state(_:)`, `action(_:)` and,
  with effects, `effect(_:)`, under `// MARK: - Mapping`) and holds a
  `SharedViewModelLease`
  it closes in `deinit`, a method of `ScreenModelFactory` implemented by
  `SharedScreenModelFactory`, and a `Scripted<X>ScreenModel` alias of
  `ScriptedScreenModel` for previews and tests, which never starts the Kotlin
  runtime. Effects reach observers through `EffectQueue`: in every bridge whose
  ViewModel has effects, one task collects the Kotlin effect flow for the
  bridge's whole life (`EffectQueue(collecting:)`), so the Kotlin channel never
  drops an effect for a cancelled collector; each effect reaches exactly one
  observer once or waits for the next one, and a newer observer's stream ends
  the previous one. A bridge whose ViewModel's effect type is `Nothing`
  (`SharedDetailScreenModel`) has no queue and returns a stream that finishes
  at once. States reach observers through `relay`, one Kotlin collection per
  observer. A pre-compile phase runs `mobile/scripts/kmp-framework --build-only`.
- `Modules/Core/DesignSystem` — `Theme` tokens, `StatusView` (loading, empty,
  failure with retry), `inlineNavigationTitle()`, `listRowButton()` (the
  whole-row style of a `Button` in a `List`, which every such row uses) and
  `StatusIdentifiers`; it uses SwiftUI only.
- `Modules/Core/Dependencies` — `SceneContainer`, the Factory container each
  scene creates, which registers the `ScreenModelFactory`.
- `Modules/Features/Home` (`HomeFeature`) and `Modules/Features/Settings`
  (`SettingsFeature`) — per screen,
  `Sources/Layers/PresentationLayer/Screens/<X>Screen/` holds `<X>Screen.swift`
  and, for a screen with a shared ViewModel, `<X>ViewModel.swift`: an internal
  `@MainActor final class … : ObservableObject` over `any <X>ScreenModel`,
  created only inside the screen's `@StateObject(wrappedValue:)` autoclosure
  and observed in the screen's `.task`. The public surface is the
  `<Feature>ScreenFactory`, which takes a `makeModel` closure, and the routing
  protocol in `Sources/Routing/`; next to them are the module's identifiers
  enum, `Resources/Localizable.xcstrings` and `Tests/`. About has no shared
  ViewModel: `AboutScreen` is a view that closes itself through
  `@Environment(\.dismiss)`.
- `Projects/App` — the `Semprec` app target: `SemprecApp` (one `WindowGroup`),
  `AppScene` (a `TabView(selection:)` with a NavigatorUI
  `ManagedNavigationStack` per tab, the selected tab and the scene's root
  `Navigator` in its own `@State`, and the view of every `AppDestination`,
  built by static functions from closures that capture only the composition,
  the destination provider weakly), `AppComposition` (one per scene: the
  screen model factory, the scene's `NavigationContext`, whose `push` skips
  the destination already on top of a stack as Android does, the routers, the
  version and build from `Bundle.main`), `NavigatorStackAdapter` (a tab's
  NavigatorUI stack, which remembers what it pushed to tell the stack's top),
  the routers `AppHomeRouter` and
  `AppSettingsRouter`, the Info.plist keys in `Project.swift`, and the macOS
  App Sandbox entitlements (`Entitlements/Semprec.entitlements`, applied only
  for `sdk=macosx*`). A pre-compile phase runs
  `mobile/scripts/kmp-framework --embed`.
- `docs/auth-bridge.md` — the native-session bridge contract of issue #141,
  which no code implements yet.

The unit test bundles run hosted in the app and in the `Semprec` scheme:
`CoreKitTests` check every mapping branch of the bridges with Kotlin values
they build (`SharedMappingTests`) and drive the real Kotlin ViewModels through
the bridges (`SharedScreenModelTests`), `HomeFeatureTests` and
`SettingsFeatureTests` use scripted models, and `SemprecTests` cover the
routers and `NavigationContext` over a spy and a real `Navigator`
(`NavigationTests`), the real `AppScene` in a window, where the Home router
pushes onto the Home stack and the Settings router presents About as a sheet
over the Settings stack (`AppSceneNavigationTests`), and that a closed scene
releases its composition (`SceneLifetimeTests`); only `SemprecTests` links
against the app executable (`BUNDLE_LOADER`), and it is the one test bundle
that imports NavigatorUI. The
XCUITest bundle `SemprecUITests` (`Projects/App/UITests/`, its own
`SemprecUITests` scheme, iOS simulator only) launches the app and walks its
flows by the identifiers the app and the features declare, compiling
`AppIdentifiers.swift`, `HomeIdentifiers.swift` and `SettingsIdentifiers.swift`
instead of importing their modules; no UI test runs on macOS. The platform
conditionals in the modules and the app are two DesignSystem modifiers:
`#if os(iOS)` in `Modules/Core/DesignSystem/Sources/View+InlineNavigationTitle.swift`
and `#if os(macOS)` in `Modules/Core/DesignSystem/Sources/View+ListRowButton.swift`;
among the tests, the shared window helper
`Projects/App/Tests/Support/SceneWindow.swift` branches on the window type,
and `AppSceneNavigationTests` on what only one platform can check (the About
sheet's title on iOS, a click beside a row's label on macOS). The
decisions this platform is held to are
`docs/adr/2026-10-24-kotlin-multiplatform-below-native-mobile-ui.md` (one
SwiftUI codebase for iOS and macOS, CoreKit's sources as the only production
importer of the framework, the tool choices),
`docs/adr/2026-10-24-shared-screen-viewmodel-lifecycle-and-native-hosting.md`,
`docs/adr/2026-10-24-app-owned-mobile-navigation-through-feature-routers.md`,
`docs/adr/2026-10-24-mobile-copy-localized-natively-from-typed-state.md`,
`docs/adr/2026-10-24-mobile-backend-calls-through-shared-data-layer.md` and
`docs/adr/2026-10-24-monorepo-holds-backend-web-and-mobile.md`, next to the
repository-wide `docs/adr/2026-09-10-no-speculative-generality-beyond-issue-scope.md`.

`mobile/scripts/verify` runs the mechanical checks (`mobile/scripts/verify
[all|architecture|shared|android|apple]`). Its `architecture` step runs
`node mobile/scripts/architecture.mjs` with the policy in
`mobile/scripts/architecture-policy.json`; for this app it enforces the Tuist
dependencies and Swift imports of every target (`ARCH-APPLE`),
`import SharedSDK` only in CoreKit's sources and in `CoreKitTests`, the one
target whose policy entry allows it (`KMP-FRAMEWORK`), exactly one CoreKit
bridge per shared screen ViewModel, also one that extends `ScreenViewModel`
through another class, and `lease.close()` in the `deinit` of every bridge
(`VM-BRIDGE`), `NavigatorUI` imported only by the app target and its tests
(`SemprecTests`) and by no `*ViewModel.swift` (`NAV-OWNERSHIP`), the identity
values of `ProjectConfiguration.swift` (`APPLE-IDENTITY`), a `<X>Screen.swift`
next to every `<X>ViewModel.swift` that sits directly in a folder below a
`Screens/` directory (`ORG-SCREEN`), and the String Catalog keys of every
target matching the policy's copy keys, each with a translated, non-empty
English and Czech value, in catalogs whose source language is `en`
(`COPY-PARITY`). `ORG-SCREEN` looks only into the folders directly below a
`Screens/` directory: a screen view or ViewModel anywhere else in a target's
sources, for example directly in `Sources/`, or several unrelated primary
types in one file pass it, and the review checks them
(`tasks/architecture.md`). Its `apple` step checks the Tuist version and the SwiftLint
version (`swiftlint_version` in `.swiftlint.yml`, 0.65.1), runs
`swiftlint lint --strict` (`.swiftlint.yml`, including the
`kmp_framework_outside_corekit` rule, which exempts CoreKit's `Sources` and
`Tests`), generates the workspace, builds Debug
and Release for the iOS Simulator, an iOS device (`generic/platform=iOS`) and
macOS, builds the iOS-only `SemprecUITests` target for the iOS Simulator
(`build-for-testing`, no device needed), and runs the `Semprec` scheme's tests on
macOS; only when the caller passes an iOS simulator does it run them there and
then the `SemprecUITests` scheme, so without one the UI tests compile but do not
run. No CI job runs
`mobile/scripts/verify` — `.github/workflows/ci.yml` has no mobile step — so
these checks hold only where the author ran them. The tasks here therefore do
not re-derive across the tree what the checks enforce, but a violation the diff
itself shows is still reported under the task item that covers it, with the
check's rule ID.

Work is planned as a dependency DAG of GitHub issues, each fully
self-contained; an issue may be implemented in parallel with any other issue
it does not declare a dependency on (`.github/ISSUE_FORMAT.md`). A pull
request is expected to close exactly one such issue and implement only what
it describes.

This platform also reviews changes to its own `review-rules/` directory — the
rules, tasks, severities and scope enforced here — through
`tasks/review-rules.md`, which reports nothing for a pull request that does not
touch them.
