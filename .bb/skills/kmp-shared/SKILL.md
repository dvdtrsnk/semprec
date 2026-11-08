---
name: kmp-shared
description: "How the Kotlin Multiplatform layer under mobile/shared is shaped and changed - the module graph, what commonMain may import, the narrow SharedSDK framework Swift sees through SKIE, typed failures and cancellation across the Kotlin-Swift boundary, every native consumer changed together, and the JVM, native and framework checks. Load this BEFORE editing anything under mobile/shared/ or changing what the framework exports. Triggers on: mobile/shared/, commonMain, commonTest, semprec.kmp, :shared:core, :shared:domain, :shared:data, :shared:presentation, :shared:umbrella, export(project(, SharedSDK, @HiddenFromObjC, @Throws, SKIE, onEnum(of:, FailureKind, RepositoryResult, PlaceholderRepository, a use case, expect/actual, a public suspend fun or Flow, sharedJvmTest, sharedAppleTest, -Pmobile.iosSimulatorId, linkDebugFrameworkIosSimulatorArm64, kmp-framework, and networking or persistence in mobile code. Skip only when nothing under mobile/shared/ and nothing exported changes."
---

# One Kotlin layer below both UIs. Swift sees only its narrow front.

Recorded as ADRs: `docs/adr/2026-10-24-kotlin-multiplatform-below-native-mobile-ui.md`
(the module graph, the export, the tool choices) and
`docs/adr/2026-10-24-mobile-backend-calls-through-shared-data-layer.md`.

Load `shared-viewmodel` for the screen ViewModel contract itself; this skill is
the layer around it.

## 1. The module graph is fixed

Gradle root is `mobile/`. Each project directory matches its Gradle path
(`:shared:core` lives in `mobile/shared/core`), and every shared module applies
the `semprec.kmp` convention plugin from `mobile/build-logic/`.

| Module | Holds today | Depends on |
|---|---|---|
| `:shared:core` | `FailureKind` | nothing |
| `:shared:domain` | `PlaceholderItem`, the `PlaceholderRepository` port, `RepositoryResult`, the use cases `LoadPlaceholderItems` and `LoadPlaceholderItem` | core (`api`) |
| `:shared:data` | `InMemoryPlaceholderRepository` | domain |
| `:shared:presentation` | `ScreenViewModel` and the screen ViewModels with their state, action and effect types, `HomeViewModelFactory` | core (`api`), domain (`implementation`), never data |
| `:shared:umbrella` | `HomeSDK`, the composition root, and the `SharedSDK` framework | domain and data (`implementation`), presentation and core (`api` and `export`) |

The `ARCH-GRADLE` rule of `mobile/scripts/architecture.mjs` fails a
`project(":…")` dependency that `mobile/scripts/architecture-policy.json` does
not allow, and any cycle. Why: presentation without data means no presentation
signature can name a data type, and an umbrella that exports only presentation
and core keeps the APIs of domain and data from being exported whole (§3 says
what keeps their single types out).

Each layer keeps its job:

- Domain decisions live in use cases: validation, ordering, derivation.
  `LoadPlaceholderItems` rejects blank or duplicate ids and sorts;
  `LoadPlaceholderItem` turns an item with another id into `INVALID_DATA`. A
  use case that only forwards to the repository is neither required nor
  forbidden (`mobile/review-rules/rules.md` does not report it either way);
  what matters is that domain decisions stay in the domain layer and none is
  made in native code.
- Data implements domain ports and holds no user-visible text.
- Presentation turns use-case results into screen state (`shared-viewmodel`).
- The umbrella composes by hand; there is no DI library in shared code.

## 2. commonMain compiles for five targets

`semprec.kmp` declares `jvm()`, `androidTarget()`, `iosArm64()`,
`iosSimulatorArm64()` and `macosArm64()`, and builds the Apple targets for the
app's minimum OS versions (iOS 26.0, macOS 26.0 from
`mobile/gradle/project.properties`). An API used in `src/commonMain` must exist
on all five. There are no x64 Apple targets, because the Apple app is arm64
only.

No platform import in `src/commonMain`: not `android.`, not `androidx.` (except
`androidx.lifecycle.ViewModel` and `androidx.lifecycle.viewModelScope`, which
`kotlinCommon.allowedImports` of the policy lists), not `java.`, `javax.`,
`platform.` or `kotlinx.cinterop.`. The `KMP-COMMON` rule checks it. Why: a
platform type in common code either fails one target's compile or ties the
shared layer to one UI.

Pin every new library in `mobile/gradle/libs.versions.toml` and check that its
artifact supports all five targets before you use it in commonMain.

There is no networking and no persistence yet. Every backend call of a mobile
app will be Kotlin code in `:shared:data` implementing a port that
`:shared:domain` declares, reached only through use cases and shared
ViewModels. No other mobile code talks to the backend, with `URLSession`,
OkHttp, `HttpURLConnection`, Ktor or anything else: not an Android module, a
SwiftUI view, a feature ViewModel, CoreKit, the Apple app, or the presentation
module. The issue that adds the first call chooses the HTTP client and the wire
format, and adds the Android `INTERNET` permission and the macOS
`com.apple.security.network.client` entitlement
(`docs/adr/2026-10-24-mobile-backend-calls-through-shared-data-layer.md`).

## 3. The exported framework stays narrow

`mobile/shared/umbrella/build.gradle.kts` builds the dynamic framework
`SharedSDK` for `iosArm64`, `iosSimulatorArm64` and `macosArm64`, with
`export(project(":shared:presentation"))` and `export(project(":shared:core"))`
and SKIE 0.10.9 applied.

Kotlin/Native puts into the header every type that a public exported
declaration references, from any module and over either dependency kind; a type
of a module that is not exported just gets a module-name prefix (the lifecycle
`ViewModel` and the coroutines `Flow` types appear that way today, through
`ScreenViewModel`). Keeping domain and data `implementation` dependencies of the
umbrella only stops someone from exporting either module as a whole, because
`export(...)` takes `api` dependencies only. Their types stay out of the header
because nothing public and exported references them: the ViewModel constructors
and `toHomeItem()` are `internal`, `HomeSDK` keeps its repository and factory
`private`, and `HomeViewModelFactory` is `@HiddenFromObjC`.

- Never export domain or data. When state needs a domain value, map it to a
  presentation type: `HomeItem` from `PlaceholderItem` through the internal
  `toHomeItem()`.
- Anything public in presentation or the umbrella that takes or returns a
  domain or data type is `internal`, `private`, or hidden from Swift with
  `@OptIn(ExperimentalObjCRefinement::class) @HiddenFromObjC`, as
  `HomeViewModelFactory` is. An `implementation` edge does not keep it out.
- `HomeSDK` returns a new ViewModel per call and is what Swift constructs
  (one per scene in `SharedScreenModelFactory`).

What Swift sees, through SKIE: a Kotlin enum is a Swift enum (`.loading`), a
sealed interface is switched with `onEnum(of:)`, a `data object` is `.shared`
(`HomeActionRetry.shared`), a `StateFlow` is a `SkieSwiftStateFlow` with a
synchronous `.value`, a `Flow` is an `AsyncSequence`, an `Int` is an `Int32`,
and names are flat (`HomeState`, `FailureKind`). `CoreKit` is the only Swift
module whose sources import `SharedSDK`, as
`@preconcurrency internal import SharedSDK`; its test target `CoreKitTests`
imports it too, to build Kotlin values for the mapping tests. The `KMP-FRAMEWORK`
rule and the SwiftLint rule `kmp_framework_outside_corekit` fail the import in
any other target, other test targets included.

## 4. Failures are values, cancellation is not

- An expected failure crosses every boundary as a value:
  `RepositoryResult.Failure(FailureKind)` from ports and use cases, then
  `failure: FailureKind` in screen state. Never as an exception. Why: Kotlin
  terminates the process when an exception escapes to Swift through a function
  without `@Throws`, and a typed value is the only failure Swift and Compose
  can render on purpose.
- The exported API has no `@Throws` today. If an exception ever becomes part of
  the Swift contract, declare it narrowly on that function; never blanket
  `Throwable`.
- Rethrow `CancellationException` before any `catch (Exception)`, and never
  wrap a suspend call in `runCatching`. A closed or superseded load ends
  silently; it is not an error state (`shared-viewmodel` §1).
- Declare what each exported member promises: nullability (an unknown id is
  `Content(null)`, which the ViewModel shows as `NOT_FOUND`), collection
  order, the sealed cases, and when a stream ends (the effect flow completes on
  `close()`).

## 5. Change every consumer in the same change

A change to an exported type breaks the Swift and Android code that renders it,
so they move together:

- the CoreKit Swift values in `Sources/Models/` and the bridge mappings
  (`state(_:)`, `action(_:)`, `effect(_:)` in `Sources/Shared/Shared<X>ScreenModel.swift`,
  shared values in `Sources/Shared/SharedValues.swift`) with their cases in
  `Tests/SharedMappingTests.swift`;
- the Android layouts and router mappings in the feature module;
- the previews and tests that build `Scripted*ScreenModel` values;
- the tests on both platforms.

Write `when` and `switch` without `else` or `default` over shared enums and
sealed types, so a new case fails the build in every consumer.

Xcode rebuilds the framework itself: CoreKit's pre-compile phase runs
`mobile/scripts/kmp-framework --build-only`, which runs
`:shared:umbrella:assemble<Configuration>AppleFrameworkForXcode<Target>`, and
the app's phase runs `--embed`. Never copy a framework by hand; a stale one
hides API and link errors.

## 6. Verify each boundary separately

From `mobile/`, with `eval "$(bb device-lab env)"` on this Mac (it exports
`DEVELOPER_DIR`, `JAVA_HOME` and `ANDROID_HOME`):

| Command | Proves |
|---|---|
| `./gradlew sharedJvmTest` | every shared module's tests on the JVM, the fast loop |
| `./gradlew sharedAppleTest` | the same tests natively, `macosArm64Test` of every shared module; fails on a host that is not an Apple silicon Mac |
| `./gradlew sharedAppleTest -Pmobile.iosSimulatorId=<UDID>` | adds `iosSimulatorArm64Test` on a simulator you reserved (`mobile-verify`) |
| `./gradlew :shared:umbrella:linkDebugFrameworkIosSimulatorArm64 :shared:umbrella:linkDebugFrameworkMacosArm64` | the framework links for the iOS simulator and macOS; `linkDebugFrameworkIosArm64` adds the iPhone slice, which the `apple` step of `mobile/scripts/verify` builds through its `generic/platform=iOS` builds |
| `./gradlew detektAll -PdetektAutoFix=false` | detekt over shared, Android and build-logic Kotlin |
| `mobile/scripts/verify architecture shared` | the architecture rules, then `sharedJvmTest sharedAppleTest detektAll -PdetektAutoFix=false` |

Any build whose task graph contains `iosSimulatorArm64Test` fails before it
starts without `-Pmobile.iosSimulatorId`, including `check`, `allTests` and
`build`. Why: Kotlin/Native would otherwise boot and shut down a simulator of
its own choice, and the simulators on this host belong to whoever reserved
them.

When the exported API changed, also run `mobile/scripts/verify android apple`:
the Swift consumers compile only against the rebuilt framework. JVM tests,
native tests, Swift compilation and linking, and runtime behaviour are four
different pieces of evidence; report each one you ran, with its test count,
and say which you did not run. Group failures by their first cause and stop
after three runs that bring no new evidence.

## Before committing, check

- [ ] Every new `project(":…")` edge stays inside the graph in §1, and the
      architecture policy allows it.
- [ ] Nothing in `src/commonMain` imports a platform API, and every new
      library supports all five targets.
- [ ] Domain and data types stay out of the framework: nothing public and
      exported takes or returns one; such a declaration is `internal`,
      `private` or `@HiddenFromObjC`.
- [ ] Expected failures are `FailureKind` values; `CancellationException` is
      rethrown before any broad catch.
- [ ] The CoreKit bridge, the Android screens, the scripted previews and the
      tests on both platforms changed with the exported type.
- [ ] `sharedJvmTest`, `sharedAppleTest` and, for an export change, the
      Android and Apple steps ran, and the report names what did not run.
