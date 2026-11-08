---
name: apple-swiftui
description: "How the Apple app under mobile/apple is written - one SwiftUI codebase building native iOS/iPadOS and macOS apps (not Catalyst) from the same targets, platform conditionals only where they differ, no UIKit or AppKit, CoreKit as the only door to Kotlin, feature ViewModels created once in the @StateObject autoclosure, String Catalogs, accessibility identifiers, the Tuist module recipe, SwiftLint and both destinations verified. Load this BEFORE changing Swift, a Tuist manifest, a String Catalog or SwiftLint config under mobile/apple. Triggers on: mobile/apple/, @StateObject, ObservableObject, @Observable, @State, #Preview, .task, #if os(, UIKit, AppKit, ScreenModel, ScriptedScreenModel, *ScreenFactory, *Routing, *Identifiers, accessibilityIdentifier, StatusView, listRowButton, XCUITest, Localizable.xcstrings, Project.swift, Workspace.swift, SemprecProject, ProjectConfiguration.swift, tuist, xcodebuild, FactoryKit, NavigatorUI, swiftlint. Skip only when nothing in mobile/apple/ changes."
---

# One SwiftUI codebase, two native apps. Shared unless they truly differ.

Recorded as ADRs: `docs/adr/2026-10-24-kotlin-multiplatform-below-native-mobile-ui.md`
(one SwiftUI codebase for iOS and macOS, native macOS rather than Catalyst,
CoreKit's sources as the only production code importing the framework, the
tool choices) and
`docs/adr/2026-10-24-shared-screen-viewmodel-lifecycle-and-native-hosting.md`
(`ObservableObject` and the `@StateObject` autoclosure).

Load `shared-viewmodel` for the CoreKit bridge and the screen contract,
`mobile-navigation` for routers and stacks, and `mobile-verify` for the
commands.

## 1. One codebase, both platforms

Every target uses `SemprecProject.destinations` (`[.iPhone, .iPad, .mac]`) and
`SemprecProject.deploymentTargets` (iOS 26.0 and macOS 26.0 from
`Tuist/ProjectDescriptionHelpers/ProjectConfiguration.swift`), builds arm64
only (`ProjectConfiguration.architectures`, the `ARCHS` of every project and of
the Swift packages), and compiles in Swift 6 with complete strict concurrency.
The macOS app is a native macOS build of the same targets, not Mac Catalyst,
because Kotlin/Native has no Catalyst target. The one target that builds for
iPhone and iPad only is the XCUITest bundle `SemprecUITests`
(`destinations: [.iPhone, .iPad]`, `.iOS(ProjectConfiguration.iosMinimum)`),
because macOS XCUITest needs the Accessibility permission, which a build
machine does not grant; give no other target its own destinations.

- Write a platform conditional only where iOS and macOS really diverge, and
  wrap it in one small view modifier in `DesignSystem` so screens stay free of
  `#if`. There are two in the modules and the app today, both in DesignSystem:
  `inlineNavigationTitle()` in
  `Modules/Core/DesignSystem/Sources/View+InlineNavigationTitle.swift`
  (`#if os(iOS)`), because a macOS window has no large title to replace, and
  `listRowButton()` in `Modules/Core/DesignSystem/Sources/View+ListRowButton.swift`
  (`#if os(macOS)`), because a `Button` in a macOS `List` keeps the bordered
  push button style and reacts only on its capsule, while on iOS the whole row
  already reacts and highlights (§3).
- Tests that host a view in a real window are the one exception: the window
  type differs (`NSWindow` on macOS, `UIWindow` on iOS), so the app's tests
  keep their `#if os(macOS)` in the shared window helper
  `Projects/App/Tests/Support/SceneWindow.swift`, which reaches both types
  through `import SwiftUI` alone, and `AppSceneNavigationTests` branches only
  for what one platform can show: the About sheet's title on iOS (a macOS
  sheet window has none) and a click beside a row's label on macOS.
- No `import UIKit` and no `import AppKit` in any module or in the app; use
  SwiftUI and Foundation. Why: either import breaks the other platform's
  build, and every type in a shared module must compile for both. `ARCH-APPLE`
  allows only the system modules listed in `apple.systemModules` of
  `mobile/scripts/architecture-policy.json` (`Combine`, `Foundation`,
  `SwiftUI`, `Synchronization`, `XCTest`), so either import fails it.
- Prefer SwiftUI API that both platforms have over a branch per platform:
  `AboutScreen` places its Done button with the semantic
  `ToolbarItem(placement: .confirmationAction)`, which builds for both.
- Each window is one `AppScene` with its own `AppComposition`, so windows
  share neither screen models nor navigation. Keep anything a scene creates
  inside its composition, never in a global. The one exception is the root
  NavigatorUI `Navigator`, which `AppScene` holds in its own `@State`, and no
  closure handed to NavigatorUI may capture `self` (`mobile-navigation` §3):
  otherwise a closed window keeps its composition and Kotlin SDK alive.

## 2. Modules and what each may import

| Target (project path) | Holds | Depends on |
|---|---|---|
| `CoreKit` (`Modules/Core/CoreKit`) | the only sources that import `SharedSDK`; `ScreenModel`, the Swift screen values, the `Shared*ScreenModel` bridges, `ScreenModelFactory`, `SharedScreenModelFactory`, `ScriptedScreenModel`, `EffectQueue` | no project dependency; its `kmp-framework` phase builds `SharedSDK` and `OTHER_LDFLAGS` links it |
| `DesignSystem` (`Modules/Core/DesignSystem`) | `Theme` tokens (`Theme.Opacity.pressed` among them), `StatusView`, `StatusIdentifiers`, `inlineNavigationTitle()`, `listRowButton()`, the `state.*` strings | nothing |
| `Dependencies` (`Modules/Core/Dependencies`) | `SceneContainer`, the Factory container of one scene | CoreKit, `FactoryKit` |
| `HomeFeature`, `SettingsFeature` (`Modules/Features/<Name>`) | screens, feature ViewModels, routing protocol, identifiers, strings | CoreKit, DesignSystem |
| `Semprec` (`Projects/App`) | `SemprecApp`, `AppScene`, `AppComposition`, navigation, routers | CoreKit, Dependencies, both features, `NavigatorUI` |

Test targets (`CoreKitTests`, `HomeFeatureTests`, `SettingsFeatureTests`,
`SemprecTests`) depend on the target they test, the feature tests on CoreKit
too, and `SemprecTests` on `NavigatorUI`, because `NavigationTests` and
`AppSceneNavigationTests` drive the app's real stacks. `CoreKitTests` is the
only test target that imports `SharedSDK`: `SharedMappingTests` builds Kotlin
values for the bridges' mappings. `SemprecUITests` depends on the app it
launches (`appUnderTest` in the policy) but imports nothing of it: it finds
elements by identifier, and compiles `Sources/AppIdentifiers.swift`,
`HomeIdentifiers.swift` and `SettingsIdentifiers.swift` one file each through
its `sources:`. An identifier file therefore imports no module of the app;
`ARCH-APPLE` checks a borrowed file's imports against the borrowing target. A
feature never imports another feature, `NavigatorUI`, `FactoryKit` or
`SharedSDK`. The
`ARCH-APPLE` rule of `mobile/scripts/architecture.mjs` compares every `import`
in Sources and Tests and every Tuist dependency with
`mobile/scripts/architecture-policy.json`, because Xcode compiles an undeclared
import inside one workspace without complaint. `KMP-FRAMEWORK` and the
SwiftLint rule `kmp_framework_outside_corekit` keep `SharedSDK` inside
CoreKit's `Sources` and `Tests`.

## 3. A screen over a shared ViewModel

A feature's screen files sit under
`Sources/Layers/PresentationLayer/Screens/<X>Screen/`. `ORG-SCREEN` checks only
that a `<X>ViewModel.swift` directly in a folder below `Screens/` has its
`<X>Screen.swift` next to it; a screen or ViewModel anywhere else passes it,
and the review reports it (`mobile/apple/review-rules/tasks/architecture.md`).

- `<X>ViewModel.swift`: `@MainActor final class XViewModel: ObservableObject`,
  internal. It holds `private let model: any XScreenModel` and the router,
  sets `@Published private(set) var state` from `model.state` in `init`,
  applies changes in `func observe() async` through
  `model.observe(onState:onEffect:)` with `[weak self]`
  (`observe(onState:)` when the effect type is `Never`), forwards each intent
  with `model.send(_:)`, and maps each effect to a router call in a private
  `route(_:)`. No protocol, `Impl` or mock: previews and tests use the
  `Scripted*ScreenModel` typealiases from CoreKit instead.
- `<X>Screen.swift`: an internal `struct XScreen: View` with
  `@StateObject private var viewModel: XViewModel` and
  `init(viewModel: @autoclosure @escaping () -> XViewModel) { _viewModel = StateObject(wrappedValue: viewModel()) }`.
  Its `body` ends with `.task { await viewModel.observe() }`.
- `Sources/<Name>ScreenFactory.swift`: the public `@MainActor enum` the app
  calls. Each screen function takes
  `makeModel: @escaping @MainActor () -> any XScreenModel` and the router, and
  returns `XScreen(viewModel: XViewModel(model: makeModel(), router: router))`,
  so `makeModel()` runs inside the autoclosure, once per screen identity.

Never create a screen model in `body`, in a destination builder outside that
autoclosure, or in an `@State` initial value; never replace the
`ObservableObject` with `@Observable` plus `@State` (the hosting ADR records
why: every view init would create a Kotlin ViewModel). Keep private `@State`
for view-local UI state, `let` for read-only inputs, `@Binding` for real
write-back, and `@ObservedObject` for an object a child observes but does not
own.

A screen with no decisions has no ViewModel: `AboutScreen` takes `version` and
`build` and dismisses itself through `@Environment(\.dismiss)`.

Every list row that is a `Button` gets `.listRowButton()` from DesignSystem,
before its `.accessibilityIdentifier(...)`, as `HomeScreen` and
`SettingsScreen` do: `Button(...) { viewModel.select(row) }.listRowButton()`.
On macOS it makes the whole row's width react to a click; on iOS it keeps the
system row highlight; the button keeps its accessibility trait on both. Arrow
keys and Return do not move through a macOS list; that would need
`List(selection:)` and is not done today.

## 4. Copy, identifiers, status and tokens

- Every user-visible string comes from the module's
  `Resources/Localizable.xcstrings` (source language `en`, every key
  translated to `cs`): `Text("home.title", bundle: .module)` or
  `String(localized: "failure.unavailable", bundle: .module)` inside a module.
  A string with arguments keeps its plain dotted key and formats afterwards:
  `String(format: String(localized: "home.item.title", bundle: .module), locale: .current, ordinal)`
  (catalog value `Placeholder item %lld`). The app target's strings use the
  main bundle (`Tab("tab.home", systemImage: "house")`). Load
  `canonical-keys` before adding a key.
- Each module declares its accessibility identifiers in one internal enum
  (`StatusIdentifiers`, `HomeIdentifiers`, `SettingsIdentifiers`,
  `AppIdentifiers`). Each value equals the Android test tag of the same
  element; a screen's root applies
  `.accessibilityElement(children: .contain)` and its identifier. The one
  Android tag without an Apple counterpart, `detail.back`, is documented in
  `HomeIdentifiers.swift`, because the back button belongs to the system
  navigation stack.
- Loading, empty and failure use `StatusView(.loading)`,
  `.empty(message:systemImage:)` and `.failure(message:retry:)`. A failure's
  text is `FailureKind.message(for:)`
  (`Modules/Features/Home/Sources/Extensions/FailureKind+Message.swift`), which
  gives `failure.unexpected` for `nil`.
- Colors, spacing and fonts come from `Theme` in DesignSystem, not literals.

## 5. Access, previews and file layout

- A feature makes public only its `<Name>ScreenFactory` and its
  `<Name>Routing` protocol; screens, ViewModels and identifiers stay internal,
  and tests reach them with `@testable import`.
- Previews are `#Preview` blocks at the end of the screen file over
  `Scripted*ScreenModel` and the internal `Preview<Name>Router` from
  `Sources/Routing/<Name>Routing.swift`, inside a `NavigationStack` when the
  screen is shown in one. They never create `SharedScreenModelFactory`, so
  they never start the Kotlin runtime.
- One primary type per file, named after it. MARK sections in the order the
  existing files use: a view has `Dependencies`, `Init`, `Body`, then
  `// MARK: - Subviews` as a `private extension`, then `// MARK: - Preview`;
  a ViewModel has `Dependencies`, `Published Properties`, `Init`, `Methods`,
  then `// MARK: - Private`; a production type's conformance to one of the
  app's own protocols (`ScreenModel`, `ScreenModelFactory`, `StackNavigating`,
  a `*Routing`) goes into an extension under `// MARK: - Protocol conformance`
  (the bridges, the factory, the stack adapter, the app routers), while
  SwiftUI and Foundation protocols such as `View` or `ObservableObject` and the
  preview doubles stay on the declaration (`AppDestination` adds NavigatorUI's
  `NavigationProvidedDestination` in its own marked extension).
  SwiftLint's custom rules `marked_extension` and
  `no_newline_after_class_declaration` check part of this.

## 6. The Tuist module recipe

A new module copies `Modules/Features/Home/Project.swift`:

- `Project(name: "<Name>Feature", options: .options(automaticSchemesOptions: .disabled), settings: SemprecProject.moduleSettings(loadsKotlinFramework: true), targets: […], resourceSynthesizers: [])`.
  `loadsKotlinFramework` is `true` for every module that imports CoreKit,
  directly or through another module, because it then loads the framework's
  Swift module and needs its search path. `resourceSynthesizers: []` keeps
  Tuist from generating string accessors; copy is read by key
  (`docs/adr/2026-10-24-mobile-copy-localized-natively-from-typed-state.md`).
- `SemprecProject.framework("<Name>Feature", dependencies: [.project(target: "CoreKit", path: "../../Core/CoreKit"), .project(target: "DesignSystem", path: "../../Core/DesignSystem")], resources: ["Resources/**"])`.
- `SemprecProject.tests("<Name>FeatureTests", for: "<Name>Feature", dependencies: [.project(target: "CoreKit", path: "../../Core/CoreKit")])`.
  Every unit test bundle runs inside `Semprec.app`, which embeds the Kotlin
  framework; `SemprecProject.tests` sets `TEST_HOST` per SDK and
  `BUNDLE_LOADER` only for `SemprecTests`. The XCUITest bundle
  `SemprecUITests` is not hosted: it launches the app.
- Add the project path to `projects` in `mobile/apple/Workspace.swift` and the
  test target to the `Semprec` scheme's test action there, then add the
  framework to the app's dependencies in `Projects/App/Project.swift`.
  `.swiftlint.yml` already includes `Modules/*/*/Sources`,
  `Modules/*/*/Tests` and `Projects/*/UITests`.
- When the UI tests drive the new feature, add its
  `../../Modules/Features/<Name>/Sources/<Name>Identifiers.swift` to the
  `sources` of `SemprecUITests` in `Projects/App/Project.swift`, one file, not
  a glob, and the flow to `Projects/App/UITests/`. The `SemprecUITests`
  scheme in `Workspace.swift` runs that one bundle.
- Only CoreKit and the app have a `kotlinFrameworkScript` phase, and only they
  set `kotlinFrameworkScriptSettings` (`ENABLE_USER_SCRIPT_SANDBOXING = NO`).
  A new module needs neither.

Identity and minimum versions live in `ProjectConfiguration.swift` and must
equal `mobile/gradle/project.properties` (`APPLE-IDENTITY`). The architectures
live there too (`ProjectConfiguration.architectures`, `arm64`), used by
`SemprecProject.projectSettings` and `Tuist/Package.swift`; they must match the
Kotlin Apple targets and the check in `mobile/scripts/kmp-framework`, which
`APPLE-IDENTITY` does not compare. Never write an `ARCHS` or deployment-target
value outside `Tuist/ProjectDescriptionHelpers/`. External packages
are pinned exactly in `Tuist/Package.swift` (Factory 2.5.1 as `FactoryKit`,
NavigatorUI 1.4.6), and `Tuist/Package.resolved`, which `mobile/.gitignore`
keeps in the repository, records the resolved revisions.

## 7. Verify both destinations

`mobile/scripts/verify apple` checks the Tuist version against
`mobile/apple/.tuist-version` and the SwiftLint version against
`swiftlint_version` in `mobile/apple/.swiftlint.yml` (0.65.1), runs
`swiftlint lint --strict`, `tuist install`
and `tuist generate --no-open`, builds the `Semprec` scheme in Debug and
Release for `generic/platform=iOS Simulator`, `generic/platform=iOS` (the
iPhone build, with the `iosArm64` Kotlin framework; no device and no signing)
and `generic/platform=macOS`, builds the `SemprecUITests` target for the iOS
Simulator (`build-for-testing`, no device), and runs the `Semprec` scheme's
tests on `platform=macOS,arch=arm64`; with `--ios-simulator <UDID>` it also
runs them on a simulator you reserved, then the `SemprecUITests` scheme there.
Without that flag the UI tests, which run on iOS only, compile but do not run.

- A full Xcode is required. On this Mac it is `/Applications/Xcode.app` while
  `xcode-select` points at the Command Line Tools, so export
  `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` (or
  `eval "$(bb device-lab env)"`) for `tuist`, `xcodebuild` and `swiftlint`;
  `verify` exports it itself when `xcodebuild -version` fails. Never run
  `sudo xcode-select`. A `swiftc -typecheck` is not an Apple build.
- Fix SwiftLint findings in the code. Do not add `swiftlint:disable` or edit
  `.swiftlint.yml` without an explicit decision in the issue.
- Report the macOS app's runtime as not verified when you could not launch and
  look at it (a process without Screen Recording permission cannot take a
  screenshot), instead of inferring it from the iOS run.

## Before committing, check

- [ ] No `UIKit` or `AppKit` import; every `#if os(...)` sits in a small
      DesignSystem view modifier (or, in the app's tests, in `SceneWindow` or
      around a check only one platform can make) and exists because the
      platforms really differ.
- [ ] Every list row that is a `Button` uses `.listRowButton()`.
- [ ] No new import or Tuist dependency outside the table in §2; `SharedSDK`
      only in CoreKit's Sources and Tests.
- [ ] No closure handed to NavigatorUI captures the scene view, and the
      composition does not hold the root navigator.
- [ ] Every feature ViewModel is created only inside its screen's
      `@StateObject` autoclosure, through the feature's screen factory.
- [ ] Every new string is in the module's String Catalog in `en` and `cs`;
      every new identifier is in the module's `*Identifiers` enum and equals
      the Android tag.
- [ ] Previews use `Scripted*ScreenModel` and preview routers.
- [ ] A new module is in `Workspace.swift` (project and scheme test target)
      and in the app's dependencies.
- [ ] `mobile/scripts/verify apple` passed for both destinations, and the
      report says whether the simulator tests and the UI tests ran.
