---
name: mobile-feature-create
description: "The vertical-slice checklist for a new mobile screen or feature - shared types and ViewModel, CoreKit bridge, Android and Apple feature modules, app routers and destinations, copy keys in both catalogs, test identifiers, tests on every layer, architecture-policy entries - plus where files go and how to refactor a screen without changing what it does. Load this BEFORE adding a screen, feature module, tab or destination under mobile/, or moving or restructuring a screen. Triggers on: a new screen, feature or tab, :android:feature:, mobile/android/feature/, mobile/apple/Modules/Features/, include( in settings.gradle.kts, Workspace.swift, Projects/App/Project.swift, HomeViewModelFactory, HomeSDK, AppModule.kt, SceneNavigation, AppDestination, ScreenModelFactory, *ScreenFactory, *Router, *Routing, *TestTags, *Identifiers, presentation/screen/, Layers/PresentationLayer/Screens/, architecture-policy.json, git mv, a refactor. Skip only when the change adds no screen and moves no mobile file."
---

# A mobile feature is one vertical slice, built on both platforms at once.

A feature here is the same slice on both apps: shared logic, an Android
feature module and an Apple feature module, composed by each app. The steps
below follow the Home and Settings features that exist; copy the nearest one
rather than inventing a structure.

Build only the screens the issue asks for. Never add a feature module, a
router method, a destination or a copy key "for later": it is a defect here
(`docs/adr/2026-09-10-no-speculative-generality-beyond-issue-scope.md`), and an
unused string fails Android lint anyway.

Load with it: `shared-viewmodel` (the contract), `kmp-shared`,
`android-compose`, `apple-swiftui`, `mobile-navigation`, `canonical-keys`,
`testing` and `mobile-verify`.

## 1. The checklist, in build order

Keep each step compiling before you start the next. `<Name>` is the feature
(`Settings`), `<X>` a screen (`About`), `<name>` the lower-case Gradle name.

**Shared (`mobile/shared/`)**

- [ ] Domain and data only when the screen needs data: an entity, a port and
      its implementation, and a use case for each domain decision
      (`kmp-shared` §1).
- [ ] `presentation`: `<X>State` (immutable, with a `<X>Phase` when it loads),
      `<X>Action`, `<X>Effect` (or `Nothing`), and `<X>ViewModel` with an
      `internal` constructor (`shared-viewmodel` §1). One concept per file,
      package `cz.semprec.app.presentation`.
- [ ] Its creation method in `HomeViewModelFactory` and a method on `HomeSDK`,
      the only factory and SDK today, each returning a new ViewModel per call.
- [ ] `commonTest` for every branch, the `close()` and store-clearing cases and
      a load that answers late (`shared-viewmodel` §3), plus the `HomeSDKTest`
      case for the new method.

**CoreKit bridge (`mobile/apple/Modules/Core/CoreKit/`)**

- [ ] `Sources/Models/<X>ScreenModel.swift`: Swift `State`, `Action` and
      `Effect` values, `typealias <X>ScreenModel = ScreenModel<…>` and
      `typealias Scripted<X>ScreenModel = ScriptedScreenModel<…>`.
- [ ] `Sources/Shared/Shared<X>ScreenModel.swift`: the bridge with
      `deinit { lease.close() }`; `EffectQueue(collecting:)` when the ViewModel
      has effects, or `effects()` returning `AsyncStream { $0.finish() }` when
      its effect type is `Nothing` (like `SharedDetailScreenModel`); internal
      static `state(_:)`, `action(_:)` and, with effects, `effect(_:)` under
      `// MARK: - Mapping`, with shared value mappings in
      `Sources/Shared/SharedValues.swift` (`shared-viewmodel` §2).
- [ ] `make<X>(…)` on `ScreenModelFactory` and on `SharedScreenModelFactory`.
- [ ] A case in `Tests/SharedMappingTests.swift` for every mapping branch,
      over Kotlin values, and a test in `Tests/SharedScreenModelTests.swift`
      against the real Kotlin ViewModel.

**Android feature (`mobile/android/feature/<name>/`)**, for a new feature module

- [ ] `include(":android:feature:<name>")` in `mobile/settings.gradle.kts`.
- [ ] `build.gradle.kts` like `feature/settings`: `id("semprec.android.compose")`,
      `implementation(project(":android:core:ui"))`,
      `implementation(project(":shared:presentation"))`, the lifecycle Compose
      library, `testImplementation(libs.junit)`.
- [ ] In `src/main/kotlin/cz/semprec/app/feature/<name>/`: `<Name>Router.kt`
      (the interface and `internal fun <Name>Router.handle(effect)`),
      `<Name>TestTags.kt`, `presentation/screen/<x>/<X>Screen.kt` and
      `<X>ScreenLayout.kt`, the feature's reusable composables in
      `presentation/components/`.
- [ ] `src/main/res/values/strings.xml` and `src/main/res/values-cs/strings.xml`.
- [ ] `src/test/` with the router mapping test.

**Android app (`mobile/android/app/`)**

- [ ] `implementation(project(":android:feature:<name>"))` in its
      `build.gradle.kts`.
- [ ] `viewModel { get<HomeSDK>().<x>ViewModel() }` in `AppModule.kt`.
- [ ] A `@Serializable` route in `AppRoutes.kt` (arguments as non-null typed
      properties) and a `composable<Route>` destination in the tab's host that
      passes `koinViewModel<…>()` to `<X>Screen`, reading arguments with
      `toRoute<Route>()` (`mobile-navigation` §2).
- [ ] The router implemented in `SceneNavigation` with its
      `NavigationCommand` cases, their encoding and their `execute` branch
      (`mobile-navigation` §2).
- [ ] For a new tab: an `AppTab` entry, its label, icon and tag in
      `AppBottomBar`, `tab.<name>` in the app's strings and a constant in
      `AppTestTags`, and its host in `AppScene`.

**Apple feature (`mobile/apple/Modules/Features/<Name>/`)**, for a new feature module

- [ ] `Project.swift` from the recipe in `apple-swiftui` §6, the project in
      `Workspace.swift` with its test target in the `Semprec` scheme, and the
      framework in the dependencies of `Projects/App/Project.swift`.
- [ ] `Sources/<Name>ScreenFactory.swift` (public), `Sources/Routing/<Name>Routing.swift`
      (the public protocol and an internal `Preview<Name>Router`),
      `Sources/<Name>Identifiers.swift`.
- [ ] `Sources/Layers/PresentationLayer/Screens/<X>Screen/<X>Screen.swift` and
      `<X>ViewModel.swift`; helpers used by one feature in `Sources/Extensions/`.
      Every list row that is a `Button` ends with `.listRowButton()` from
      DesignSystem, before its identifier (`apple-swiftui` §3).
- [ ] `Resources/Localizable.xcstrings` (source language `en`, every key
      translated to `cs`).
- [ ] `Tests/<X>ViewModelTests.swift` over `Scripted<X>ScreenModel`.

**Apple app (`mobile/apple/Projects/App/`)**

- [ ] A case in `AppDestination` and its view in `AppScene`'s
      `destinationView`.
- [ ] `App<Name>Router` implementing `<Name>Routing` over `NavigationContext`,
      created in `AppComposition`.
- [ ] For a new tab: an `AppTab` case, a `Tab(…, value: .<name>)` in
      `AppScene`'s `TabView(selection:)` with its `ManagedNavigationStack` and
      `composition.navigation.register(navigator, for: .<name>)` in its root's
      `onAppear`, a constant in `AppIdentifiers`, and `tab.<name>` in
      `Resources/Localizable.xcstrings`.
- [ ] A router test in `Tests/NavigationTests.swift`, and a case in
      `Tests/AppSceneNavigationTests.swift` that shows the real `AppScene` and
      checks the stack and presentation the new route reaches.
- [ ] When the new flow is one a user walks, a flow in
      `UITests/SmokeFlowTests.swift`, with the feature's
      `../../Modules/Features/<Name>/Sources/<Name>Identifiers.swift` added to
      the `sources` of `SemprecUITests` in `Project.swift` (one file, not a
      glob), as Android's `SmokeFlowTest` walks it.

**Copy and identifiers, on both platforms**

- [ ] Each new copy key exists on both platforms in the matching module
      (Android feature module and Apple feature module), Apple key dotted
      (`about.version`), Android name with underscores (`about_version`), in
      English and Czech (`canonical-keys`).
- [ ] Each new test identifier has the same value on both platforms, declared
      in the module's `*TestTags` object and `*Identifiers` enum.

**Architecture policy and verify**

- [ ] `mobile/scripts/architecture-policy.json` describes what you added, and
      nothing else:
      - `gradle.modules`: the new module with its allowed project dependencies
        (`":android:feature:<name>": [":android:core:ui", ":shared:presentation"]`),
        and the module added to the list of `:android:app` (`ARCH-GRADLE`);
      - `apple.targets`: `<Name>Feature` (`project` `Modules/Features/<Name>`,
        `sources` `Sources`, `allowed` `CoreKit` and `DesignSystem`) and
        `<Name>FeatureTests` (the same `project`, `sources` `Tests`, `allowed`
        `<Name>Feature` and `CoreKit`), and `<Name>Feature` added to the
        `allowed` list of
        `Semprec` (`ARCH-APPLE`);
      - `copy`: an entry pairing the Android module with the Apple target and
        listing its keys, or the new keys in an existing entry. An
        `androidOnly` key needs a reason (`COPY-PARITY`, `canonical-keys`).
      A new system framework (`apple.systemModules`) or Swift package
      (`apple.externalModules`) is a decision the issue has to make, not a
      line to add on the way.
- [ ] `mobile/scripts/verify` with both devices reserved (`mobile-verify`), and
      one open-close-reopen of the new screen on each platform.

## 2. Where files go

**Kotlin.** One package lives in exactly one module, and the directory matches
the package. A feature module uses:

```
src/main/kotlin/cz/semprec/app/feature/<name>/
  <Name>Router.kt            router contract and its effect mapping
  <Name>TestTags.kt          test tag constants
  presentation/
    screen/<x>/              <X>Screen.kt (wiring), <X>ScreenLayout.kt (stateless, private previews)
    components/              the feature's reusable composables, internal
    <Helper>.kt              feature-wide presentation helpers (FailureMessage.kt)
src/main/res/values/strings.xml, values-cs/strings.xml
src/test/kotlin/...          JVM tests, mirroring the main packages
```

**Swift.** A feature module uses:

```
Sources/
  <Name>ScreenFactory.swift          the public screens
  <Name>Identifiers.swift            accessibility identifiers
  Routing/<Name>Routing.swift        the public routing protocol and the preview router
  Layers/PresentationLayer/Screens/<X>Screen/
                                     <X>Screen.swift, <X>ViewModel.swift (no ViewModel for a view-only screen)
  Extensions/                        extensions of CoreKit types used by this feature
Resources/Localizable.xcstrings
Tests/
```

One primary type or composable group per file, named after it. Move files
with `git mv`, and update the package, imports, Koin and Factory
registrations and tests in the same change. `ORG-SCREEN` checks the screen
pairs only inside the screen folders: a `<X>Screen.kt` directly in a
`presentation/screen/<folder>/` has its `<X>ScreenLayout.kt`, and a
`<X>ViewModel.swift` directly in a folder below `Screens/` has its
`<X>Screen.swift`. A screen file outside those folders passes it, so the
review checks the layout above (each app's `tasks/architecture.md`).

## 3. Refactoring an existing screen

Before you edit, write down the screen's visible states, actions, effects,
copy keys, test identifiers, dependencies and lifetime owner. After the
refactor every item on that list must still hold.

- Extract render-only parts (a composable in `presentation/components/`, a
  computed subview in the screen's `private extension` under
  `// MARK: - Subviews`); keep effects, routing and the shared ViewModel where
  they are.
- Logic that is not platform-specific moves into the shared ViewModel or a
  use case (`shared-viewmodel`), instead of being reshaped in Compose or
  SwiftUI.
- Keep every test identifier, copy key, accessibility meaning, list key,
  error and retry path and router call. Update previews and scripted models
  with any interface change.
- Do not change behaviour or invent a new structure just to shorten a file.
  Run the screen's tests on both platforms and one device flow.

## Before committing, check

- [ ] Every box of §1 that applies to the change is done on both platforms, or
      the issue says why one platform is out of scope.
- [ ] Nothing was added that the issue does not use.
- [ ] Files sit where §2 says, with the package matching the directory.
- [ ] A refactor kept every state, action, effect, key, identifier and route
      it started with.
