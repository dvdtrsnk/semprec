This is the `mobile/` platform of the Semprec monorepo (the repository root,
`backend/`, `web/`, `mobile/android/` and `mobile/apple/` are separate
platforms with their own review-rules and are reviewed independently). The
review bot assigns each file to the platform whose directory is the longest
prefix of its path, and `scope.md` includes every file (`**`), so this
platform reviews everything under `mobile/` outside `mobile/android/` and
`mobile/apple/`: the Kotlin Multiplatform shared layer (`shared/`), the Gradle
root (`settings.gradle.kts`, `build.gradle.kts`, `gradle.properties`,
`gradlew`, `gradlew.bat`, and `gradle/` with the version catalog, the
hand-maintained `project.properties` and the wrapper), the convention plugins
(`build-logic/`), the detekt configuration (`config/detekt/detekt.yml`), the
scripts (`scripts/`), the documentation (`README.md`, `docs/`), and
`.editorconfig`, `.gitattributes` and `.gitignore`.

`shared/` is the code both native apps run below their UI. The Android modules
depend on its Gradle projects (`:shared:presentation`, and the app also on
`:shared:umbrella`); the Apple app links the `SharedSDK` framework that
`:shared:umbrella` builds, through `scripts/kmp-framework`, which build phases
of the CoreKit and app targets run. A change here therefore reaches both apps,
whose code is reviewed by their own platforms; when a shared change needs a
native consumer to change, read that consumer at the pull request's head under
`mobile/android/` or `mobile/apple/Modules/Core/CoreKit/`. Every shared module
applies `build-logic/src/main/kotlin/semprec.kmp.gradle.kts` (targets `jvm`,
`androidTarget`, `iosArm64`, `iosSimulatorArm64` and `macosArm64`, with the
Apple minimum versions from `gradle/project.properties`); a module's tests are
in its `src/commonTest` and run on the JVM and natively. The modules:

- `:shared:core` (`cz.semprec.app.core`) — `FailureKind`, the typed expected
  failures. Depends on no module.
- `:shared:domain` (`cz.semprec.app.domain`) — the `PlaceholderItem` entity,
  the `PlaceholderRepository` port, `RepositoryResult`, and the use cases
  `LoadPlaceholderItems` and `LoadPlaceholderItem`, which make the decisions
  (identity checks, ordering). Depends on core.
- `:shared:data` (`cz.semprec.app.data`) — `InMemoryPlaceholderRepository`, the
  only implementation of the port. There is no networking and no persistence.
  Depends on domain.
- `:shared:presentation` (`cz.semprec.app.presentation`) — `ScreenViewModel`,
  the screen ViewModels `HomeViewModel`, `DetailViewModel` and
  `SettingsViewModel` (internal constructors) with their state, action and
  effect types, and `HomeViewModelFactory`, which creates them and is hidden
  from Objective-C and Swift. Depends on core and domain, never on data.
- `:shared:umbrella` (`cz.semprec.app.sdk`) — `HomeSDK`, the composition root:
  it wires repository, use cases and factory by hand, with no DI library, and
  returns a new ViewModel on every call. It builds the dynamic `SharedSDK`
  framework for `iosArm64`, `iosSimulatorArm64` and `macosArm64`, exports only
  presentation and core, and applies SKIE.

The screen ViewModel contract is the KDoc of `ScreenViewModel`: one immutable
`StateFlow` state, `onAction` for intents, and one-time effects through an
unlimited `Channel` exposed with `receiveAsFlow()`. The channel delivers
effects in emission order, each to at most one collector, never replayed;
effects emitted while nobody collects wait for the next collector; a collector
cancelled after the channel handed it an effect but before it resumed drops it
(the prompt cancellation of kotlinx.coroutines). The hosts collect where that
cannot happen: Android's `CollectEffects` collects on
`Dispatchers.Main.immediate`, so an effect emitted on the main thread is
processed before any lifecycle event can cancel the collector, and Apple's
CoreKit bridge collects once for its whole life through `EffectQueue`. So
every effect emitted on the main thread is delivered exactly once while the
ViewModel (Android) or the bridge (Apple) lives, and `emit` is called only on
the main thread (`onAction`, or work in `viewModelScope`, which runs on
`Dispatchers.Main.immediate`). Android retains each ViewModel in a
`ViewModelStore`, whose clearing cancels `viewModelScope` and calls
`onCleared()`; the Apple CoreKit bridge calls `close()` exactly once from its
`deinit`. `close()` is idempotent, cancels `viewModelScope` and closes the
effect channel, and clearing ends the same. The decisions this platform is held to are
`docs/adr/2026-10-24-kotlin-multiplatform-below-native-mobile-ui.md` (what
Kotlin Multiplatform owns, the module graph, the exported API, the tool
choices), `docs/adr/2026-10-24-shared-screen-viewmodel-lifecycle-and-native-hosting.md`,
`docs/adr/2026-10-24-mobile-backend-calls-through-shared-data-layer.md`,
`docs/adr/2026-10-24-app-owned-mobile-navigation-through-feature-routers.md`,
`docs/adr/2026-10-24-mobile-copy-localized-natively-from-typed-state.md` and
`docs/adr/2026-10-24-monorepo-holds-backend-web-and-mobile.md`, next to the
repository-wide `docs/adr/2026-09-10-no-speculative-generality-beyond-issue-scope.md`.

`scripts/verify` runs the mechanical checks of all three mobile platforms
(`mobile/scripts/verify [all|architecture|shared|android|apple]`). Its
`architecture` step runs `node mobile/scripts/architecture.mjs`, whose policy
is `scripts/architecture-policy.json`, and the `node:test` suites in
`scripts/*.test.mjs`. For the code reviewed here the check enforces the Gradle
module graph (`ARCH-GRADLE`), no platform import in any `src/commonMain` other
than the lifecycle `ViewModel` and `viewModelScope` the policy allows
(`KMP-COMMON`), a `<Name>Test.kt` in commonTest, exactly one CoreKit bridge
and an Android screen for every non-abstract class extending `ScreenViewModel`
directly or through other classes of `:shared:presentation` (`VM-BRIDGE`), no
navigation library in shared code (`NAV-OWNERSHIP`), the Apple identity values of
`gradle/project.properties` (`APPLE-IDENTITY`) and the checksum of
`gradle/wrapper/gradle-wrapper.jar` (`WRAPPER`); its `node:test` suites also
cover verify's JDK and SwiftLint prerequisites and the `xcodebuild` calls of
its `apple` step (the Debug and Release builds for the iOS Simulator, an iOS
device and macOS, the build of the UI tests for the iOS Simulator, the tests on
macOS, and the simulator tests and UI tests with `--ios-simulator`), and the JDK lookup, the Gradle task per SDK and
configuration and the embed folder check of `scripts/kmp-framework`
(`scripts/toolchain.test.mjs`). Its `shared` step runs the
shared tests on the JVM and natively on macOS, and detekt with the formatting
and Compose rules and no baseline. No CI job runs `scripts/verify` —
`.github/workflows/ci.yml` has no mobile step — so these checks hold only where
the author ran them. The tasks here therefore do not re-derive across the tree
what the checks enforce, but a violation the diff itself shows is still
reported under the task item that covers it, with the check's rule ID.

Work is planned as a dependency DAG of GitHub issues, each fully
self-contained; an issue may be implemented in parallel with any other issue
it does not declare a dependency on (`.github/ISSUE_FORMAT.md`). A pull
request is expected to close exactly one such issue and implement only what
it describes.

This platform also reviews changes to its own `review-rules/` directory — the
rules, tasks, severities and scope enforced here — through
`tasks/review-rules.md`, which reports nothing for a pull request that does not
touch them.
