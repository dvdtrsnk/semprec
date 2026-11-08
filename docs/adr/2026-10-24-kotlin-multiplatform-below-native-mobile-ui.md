---
status: accepted
date: 2026-10-24
area: [mobile]
supersedes: [2026-09-10-single-shared-swift-codebase-for-ios-macos]
superseded-by: null
---

# Kotlin Multiplatform owns mobile logic from the screen ViewModel down; the UI is native

## Context

[[2026-09-10-single-shared-swift-codebase-for-ios-macos]] planned one Swift codebase for the iOS
and the macOS app, with its data layer, networking and screen logic in Swift. Semprec now needs
an Android app as well, and that plan would implement the same logic a second time in Kotlin:
every validation, ordering rule, loading/empty/error state machine and cancellation rule written
twice and drifting apart.

The alternatives considered:

- **Two native codebases**, Swift for Apple and Kotlin for Android, each with its own logic. This
  is the duplication above.
- **Shared UI as well**, with Compose Multiplatform or Flutter. Both draw their own widgets instead
  of using SwiftUI on Apple, so the Apple app would not get the system's navigation stacks,
  sheets, toolbars and accessibility behaviour from SwiftUI; Flutter would also replace Kotlin
  with Dart on Android.
- **Sharing less**, only the domain and data layers. The screen logic (load, retry, a newer load
  superseding an older one, the effect a tap raises) would still be written once per app.
- **Mac Catalyst** for the macOS app. Kotlin/Native has no Mac Catalyst target, so a Catalyst app
  could not link the Kotlin framework; Kotlin/Native does have a native macOS target
  (`macosArm64`), and SwiftUI builds a native macOS app from the same targets as the iOS app.

For linking the Kotlin framework into the Apple app, an XCFramework or a SwiftPM binary target
was considered. Both are produced by a separate step before Xcode builds, so the Swift code can
compile against a framework whose exported API is older than the Kotlin sources.

## Decision

### The split

Kotlin Multiplatform code in `mobile/shared/` owns everything from the screen ViewModel down:
domain decisions (for example `LoadPlaceholderItems` rejects blank or duplicate ids and orders
the items), data access, and each screen's state, actions and one-time effects
(`ScreenViewModel`, see [[2026-10-24-shared-screen-viewmodel-lifecycle-and-native-hosting]]).
Native code renders the state, sends actions and maps effects to navigation
([[2026-10-24-app-owned-mobile-navigation-through-feature-routers]]); it does not re-derive what
the shared code decided. Copy, theme and presentation stay native
([[2026-10-24-mobile-copy-localized-natively-from-typed-state]]).

Shared code lives in `commonMain` and imports no platform API: nothing from `android.*`,
`java.*`, `javax.*`, `platform.*` (where Kotlin/Native puts UIKit, AppKit and Foundation) or
`kotlinx.cinterop.*`, and from `androidx.*` only `ViewModel` and `viewModelScope` of the
multiplatform `androidx.lifecycle:lifecycle-viewmodel`, the base of `ScreenViewModel`. The `semprec.kmp`
convention plugin compiles every shared module for `jvm` (fast tests), `androidTarget`, `iosArm64`,
`iosSimulatorArm64` and `macosArm64`.

### Native UI

- Android: Jetpack Compose with Material 3.
- Apple: one SwiftUI codebase. Every first-party Tuist target uses `SemprecProject.destinations`
  (`[.iPhone, .iPad, .mac]`) and `SemprecProject.deploymentTargets` (iOS 26.0 and macOS 26.0), so
  one set of targets builds the iOS/iPadOS app and a native macOS app, not a Catalyst app. The one
  exception is the XCUITest bundle `SemprecUITests`, which builds for iPhone and iPad only, because
  macOS XCUITest needs the Accessibility permission, which build machines do not grant; it ships
  in no app. Code branches on the platform only where iOS and macOS genuinely differ. In the
  modules and the app that is two small modifiers in DesignSystem today: `inlineNavigationTitle()`
  (a macOS window has no large title) and `listRowButton()` (a `Button` in a macOS `List` keeps
  the bordered push button style and reacts only on its capsule). Among the tests it is the shared
  window helper `SceneWindow`, which hosts a scene in an `NSWindow` on macOS and a `UIWindow` on
  iOS, and the checks of `AppSceneNavigationTests` that only one platform can make.

### Module graph

Gradle (`mobile/settings.gradle.kts`), the edges each module may have:

| Module | May depend on |
| --- | --- |
| `:shared:core` | nothing |
| `:shared:domain` | `:shared:core` |
| `:shared:data` | `:shared:core`, `:shared:domain` |
| `:shared:presentation` | `:shared:core`, `:shared:domain` (never `:shared:data`) |
| `:shared:umbrella` | `:shared:core`, `:shared:domain`, `:shared:data`, `:shared:presentation` |
| `:android:core:ui` | no project |
| `:android:feature:home`, `:android:feature:settings` | `:android:core:ui`, `:shared:presentation` |
| `:android:app` | `:android:core:ui`, both features, `:shared:presentation`, `:shared:umbrella` |

The build scripts declare these edges or fewer; `:shared:data` gets `:shared:core` through the
`api` dependency of `:shared:domain`.

Tuist (`mobile/apple/`):

| Target | Depends on |
| --- | --- |
| `CoreKit` | the Kotlin framework `SharedSDK` (found through its search path, not a Tuist dependency) |
| `DesignSystem` | nothing |
| `Dependencies` | `CoreKit`, FactoryKit |
| `HomeFeature`, `SettingsFeature` | `CoreKit`, `DesignSystem` |
| `Semprec` (the app, `Projects/App`) | `CoreKit`, `Dependencies`, both features, NavigatorUI |

Features never depend on each other or on the app. Only the apps compose: the Android app module
and the Apple app target are the only places that see every feature.

### The framework boundary

`:shared:umbrella` builds `SharedSDK`, a dynamic framework for `iosArm64`, `iosSimulatorArm64`
and `macosArm64`, and exports only `:shared:presentation` and `:shared:core`. `HomeSDK` is the
framework's entry point.

Exporting a module puts its whole public API into the framework. A type of a module that is not
exported still appears in the header, under a module-name prefix, as soon as a public exported
declaration references it, whether the dependency is `api` or `implementation` (the base
`ViewModel` of lifecycle and the coroutines `Flow` types appear that way today). Keeping domain and
data `implementation` dependencies of the umbrella only stops either module from being exported
as a whole, because `export(...)` takes `api` dependencies only. Their types stay out of the
framework's Objective-C and Swift API because nothing public and exported references them: the
screen ViewModels' constructors and `toHomeItem()` are `internal`, `HomeSDK` keeps its repository
and factory `private`, and `HomeViewModelFactory`, which takes domain use cases, is
`@HiddenFromObjC`.

`CoreKit` is the only Swift module whose sources import `SharedSDK` (`@preconcurrency internal
import`, in `Modules/Core/CoreKit/Sources/Shared/`). It maps Kotlin state, actions and effects to
Swift value types and exposes them through `ScreenModel` protocols, so features and the app never
see a Kotlin type. Its test target `CoreKitTests` also imports `SharedSDK`, to build Kotlin values
for the tests of the bridges' mappings (`SharedMappingTests`), and the bridges keep those mappings
as internal static functions that `@testable import CoreKit` reaches. The SwiftLint custom rule
`kmp_framework_outside_corekit` in `mobile/apple/.swiftlint.yml` rejects the import anywhere else,
other test targets included.

### Build integration

The Apple build asks Gradle for the framework on every build, through `mobile/scripts/kmp-framework`:

- a pre-compile phase of `CoreKit` runs it with `--build-only`, which runs
  `:shared:umbrella:assemble<Configuration>AppleFrameworkForXcode<Target>` for the current SDK and
  configuration into `mobile/shared/umbrella/build/xcode-frameworks/$(CONFIGURATION)/$(SDK_NAME)/`,
  the framework search path of every target that loads it;
- a pre-compile phase of the app runs it with `--embed`, which runs
  `:shared:umbrella:embedAndSignAppleFrameworkForXcode` to copy the framework into the app bundle
  (`Frameworks/` on iOS, `Contents/Frameworks/` on macOS) and sign it when signing is allowed.

The phases run on every build and Gradle decides whether the framework is up to date, so Swift
always compiles against the current Kotlin API. Everything is built for arm64 only: the Kotlin
targets have no `iosX64` or `macosX64`, `kmp-framework` rejects any other `ARCHS`, and the
settings of every Tuist project and of the Swift packages take `ARCHS` from
`ProjectConfiguration.architectures` (`arm64`) in `Tuist/ProjectDescriptionHelpers/`.

### Tools

| Tool | Version | Why |
| --- | --- | --- |
| Gradle wrapper, included build `mobile/build-logic/` | 8.13 | The convention plugins `semprec.kmp`, `semprec.android.library`, `semprec.android.compose` and `semprec.android.application` give every shared module the same targets, and every module the same Android SDK levels and Java 17 bytecode; identity and SDK levels are read from `mobile/gradle/project.properties`. |
| SKIE | 0.10.9 | Swift sees `StateFlow`/`Flow` as async sequences with a synchronous `value` for `StateFlow`, sealed interfaces as exhaustive `onEnum(of:)` switches, and Kotlin enums as Swift enums. The plain Objective-C header that Kotlin/Native generates has no async iteration of flows, no exhaustive switch over a sealed interface, and exports enums as classes. |
| Koin (`koin-androidx-compose`) | 4.1.1 | `koinViewModel()` keeps each shared ViewModel in its navigation entry's `ViewModelStore`. Hilt was rejected: it creates ViewModels from `@HiltViewModel` classes with `@Inject` constructors, which `commonMain` classes cannot carry, and the shared constructors are internal. The shared code itself uses no DI library; `HomeSDK` composes by hand. |
| Tuist | 4.213.0 (`mobile/apple/.tuist-version`) | Projects and the workspace are generated from Swift manifests and not committed (`mobile/.gitignore`); `Tuist/ProjectDescriptionHelpers/SemprecProject.swift` gives every target the same destinations and project settings (the iOS-only XCUITest bundle excepted), and every unit test bundle the same hosting in the app. |
| Factory (`FactoryKit`) | 2.5.1 | A container per window (`SceneContainer`, a `ManagedContainer` without a process-wide instance) for the app composition. Today it registers one dependency, the screen model factory. |
| NavigatorUI | 1.4.6 | One managed navigation stack per tab, with every destination's view provided in one place by the app. |
| detekt with detekt-formatting and the `io.nlopez.compose.rules` Compose rules | 1.23.8 / 1.23.8 / 0.4.28 | `detektAll` checks every `.kt` file under `android/`, `shared/` and `build-logic/src` against `mobile/config/detekt/detekt.yml`; `maxIssues: 0` and no baseline. |
| Android lint | AGP 8.11.1 | `:android:app:lintDebug` checks every Android module (`checkDependencies`) and fails on any warning; only the three checks that compare against newly published versions are disabled. |
| SwiftLint | 0.65.1 (`swiftlint_version` in `mobile/apple/.swiftlint.yml`) | `swiftlint lint --strict` over `mobile/apple/.swiftlint.yml`, including the framework import rule above. SwiftLint itself stops with an error under any other version, so every machine and editor gives the same verdict. |

Swift packages are pinned exactly in `mobile/apple/Tuist/Package.swift` and
`Tuist/Package.resolved`; Gradle dependencies in `mobile/gradle/libs.versions.toml`.

## Consequences

- A screen's behaviour is implemented once and tested once in `commonTest`, which runs on the JVM
  (`sharedJvmTest`), natively on macOS and, given `-Pmobile.iosSimulatorId`, on an iOS simulator
  (`sharedAppleTest`).
- A change to a shared screen's state, actions or effects reaches three places: the Kotlin
  ViewModel, its CoreKit bridge and the Android screen that hosts it.
- Every Apple build runs Gradle and needs a JDK that Gradle can run on: 17 to 23, because the
  Android Gradle plugin needs 17 and Gradle 8.13 runs on Java 23 at most. `mobile/scripts/kmp-framework`
  uses `JAVA_HOME`, then the newest JDK of that range `/usr/libexec/java_home` knows, then `java` on
  `PATH`, and fails the build with a message when the one it takes is out of range or it finds
  none (Xcode started from the Dock or Finder does not inherit a shell's `JAVA_HOME`). The range
  belongs to the wrapper's Gradle: `mobile/scripts/verify` and `kmp-framework` each hold it once,
  `verify` fails when the wrapper pins another Gradle, and `mobile/scripts/toolchain.test.mjs`
  fails when the two scripts differ, so a wrapper upgrade updates both.
- The Apple app builds only on a Mac with full Xcode, and runs only on iPhone and iPad devices,
  the iOS simulator of an Apple silicon Mac, and Apple silicon Macs. `mobile/scripts/verify`
  builds it in Debug and Release for the iOS Simulator, for an iPhone (`generic/platform=iOS`,
  which links the `iosArm64` framework, unsigned) and for macOS.
- The Apple UI tests are one XCUITest bundle, `SemprecUITests`, in a scheme of its own that runs
  on an iOS simulator only, so the `Semprec` scheme's unit tests keep running on macOS without
  the Accessibility permission. It drives the app from outside and imports none of its modules:
  it compiles the identifier files of the app and the features one by one, and the policy names
  the app as its `appUnderTest`, which it may depend on but not import (`ARCH-APPLE`). On macOS
  the shown scene is tested only in process (`AppSceneNavigationTests` in `SemprecTests`).
- One Apple codebase means a feature is written once for iOS and macOS, and a platform branch
  needs a real difference between the two platforms, not a missing shared abstraction.
- Every tool in the table above is pinned; raising a version is a deliberate change to the catalog,
  `.tuist-version`, `swiftlint_version` in `.swiftlint.yml` or `Tuist/Package.swift`.
  `mobile/scripts/verify` fails up front when the installed Tuist or SwiftLint differs from its
  pin.
- `node mobile/scripts/architecture.mjs` checks what no compiler enforces against
  `mobile/scripts/architecture-policy.json`: the Gradle graph (`ARCH-GRADLE`), the Tuist graph and
  Swift imports (`ARCH-APPLE`), platform imports in `commonMain` (`KMP-COMMON`) and imports of the
  Kotlin framework outside the sources of CoreKit and of the targets whose `allowed` list names it,
  which is `CoreKitTests` alone (`KMP-FRAMEWORK`).
