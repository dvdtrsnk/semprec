# Semprec mobile

The native Semprec apps. Kotlin Multiplatform shares everything from the screen
ViewModels down (presentation, domain, data and core), and each platform renders
those ViewModels with its own UI toolkit: Jetpack Compose on Android, and SwiftUI on
Apple, where one codebase builds both the iOS/iPadOS app and a native macOS app (not
Mac Catalyst) from the same targets.

The apps hold placeholder screens only. The Home tab lists the five items of
`InMemoryPlaceholderRepository` and opens an item's detail; the Settings tab has an
About row that presents an About sheet with the app's version. There is no
networking, login or persistence.

How the layers fit together, how each platform hosts a shared ViewModel, navigation,
copy, test identifiers and tests: [`docs/architecture.md`](docs/architecture.md).
Paths in this file are relative to `mobile/`.

## Layout

```
mobile/
  README.md  .editorconfig  .gitattributes  .gitignore
  settings.gradle.kts         Gradle root: includes the shared and Android modules
  build.gradle.kts            aggregate tasks (sharedJvmTest, sharedAppleTest, androidUnitTest, detektAll)
  gradle.properties
  gradle/
    libs.versions.toml        version catalog
    project.properties        identity, version, Android SDK levels, Apple minimum versions
    wrapper/                  Gradle wrapper and gradle-wrapper.jar.sha256
  gradlew  gradlew.bat
  build-logic/                convention plugins semprec.kmp, semprec.android.library,
                              semprec.android.compose, semprec.android.application
  config/detekt/detekt.yml
  scripts/
    verify                    the whole mobile pipeline (see Verify below)
    architecture.mjs          the architecture check (rules in docs/verify.md)
    architecture-policy.json  what the architecture check allows
    architecture.test.mjs     node:test cases for every architecture rule
    toolchain.test.mjs        node:test cases: verify's JDK and SwiftLint checks and apple-step commands,
                              kmp-framework's JDK lookup and SDK/configuration mapping
    kmp-framework             Xcode build phase: builds or embeds the SharedSDK framework
  docs/
    architecture.md
    verify.md
  review-rules/               review platform for everything here outside android/ and apple/
  shared/
    core/  domain/  data/  presentation/  umbrella/
  android/
    app/  core/ui/  feature/home/  feature/settings/
    review-rules/
  apple/
    .tuist-version  .swiftlint.yml  Tuist.swift  Workspace.swift
    Tuist/                    Package.swift, Package.resolved, ProjectDescriptionHelpers/
    Modules/Core/             CoreKit/  DesignSystem/  Dependencies/
    Modules/Features/         Home/  Settings/
    Projects/App/             the Semprec app target, its tests (Tests/) and its iOS UI tests (UITests/)
    docs/auth-bridge.md
    review-rules/
```

The Gradle project directories follow the Gradle paths (`:shared:core` is
`shared/core`, `:android:feature:home` is `android/feature/home`). Gradle, Kotlin,
Xcode, Tuist and SwiftPM outputs, the generated Xcode projects and workspace, and
`local.properties` are ignored by `.gitignore`.

## Identity

Gradle reads these values from `gradle/project.properties` (the keys below), and
Tuist reads the Apple ones from
`apple/Tuist/ProjectDescriptionHelpers/ProjectConfiguration.swift`. The
architecture check (`APPLE-IDENTITY` in `scripts/architecture.mjs`) fails when the
two files disagree on `appleBundleId`, `frameworkName`, `versionName`,
`versionCode`, `iosMinimum` or `macosMinimum`.

| | Value | Key |
| --- | --- | --- |
| Display name | `Semprec` | not a property: Android's `app_name` string and Apple's `ProjectConfiguration.appName` (`CFBundleDisplayName`) |
| Android application id | `cz.semprec.app`; debug builds `cz.semprec.app.debug` | `androidApplicationId`; the suffix is in `android/app/build.gradle.kts` |
| Android namespace | `cz.semprec.app` for the app; a library appends its Gradle path (`cz.semprec.app.android.feature.home`) | `namespace` |
| Apple bundle id | `cz.semprec.app`; modules and tests `cz.semprec.app.<Target>` | `appleBundleId` |
| Kotlin framework | `SharedSDK`, dynamic, bundle id `cz.semprec.app.SharedSDK` | `frameworkName` |
| Gradle root project | `semprec-mobile` | `projectName` |
| Version | `0.1.0`, build `1` | `versionName`, `versionCode` |
| Android SDK | min 28, compile and target 36, build tools 36.0.0 | `androidMinSdk`, `androidCompileSdk`, `androidTargetSdk`, `androidBuildTools` |
| Apple minimum | iOS 26.0, macOS 26.0 | `iosMinimum`, `macosMinimum` |

## Toolchain

| Tool | Version | Pinned in |
| --- | --- | --- |
| Gradle | 8.13 (distribution SHA-256 checked) | `gradle/wrapper/gradle-wrapper.properties` |
| Kotlin, Kotlin/Native, Compose compiler plugin | 2.2.21 | `gradle/libs.versions.toml` |
| Android Gradle Plugin | 8.11.1 | `gradle/libs.versions.toml` |
| SKIE | 0.10.9 | `gradle/libs.versions.toml` |
| kotlinx-coroutines | 1.10.2 | `gradle/libs.versions.toml` |
| AndroidX Lifecycle | 2.10.0 | `gradle/libs.versions.toml` |
| Compose BOM | 2026.01.00 | `gradle/libs.versions.toml` |
| Activity Compose | 1.12.2 | `gradle/libs.versions.toml` |
| Navigation Compose | 2.9.8 | `gradle/libs.versions.toml` |
| kotlinx-serialization (`kotlinx-serialization-core`, for the type-safe navigation routes; the plugin is Kotlin's) | 1.9.0 | `gradle/libs.versions.toml` |
| Koin | 4.1.1 | `gradle/libs.versions.toml` |
| JUnit, AndroidX Test JUnit, Espresso | 4.13.2, 1.3.0, 3.7.0 | `gradle/libs.versions.toml` |
| detekt and detekt-formatting | 1.23.8 | `gradle/libs.versions.toml` |
| Compose rules for detekt (`io.nlopez.compose.rules:detekt`) | 0.4.28 | `gradle/libs.versions.toml` |
| Tuist | 4.213.0 | `apple/.tuist-version` |
| SwiftLint | 0.65.1 | `swiftlint_version` in `apple/.swiftlint.yml`; SwiftLint refuses to lint with that configuration under any other version, and verify checks it up front |
| Factory (`FactoryKit`) | 2.5.1 | `apple/Tuist/Package.swift` (exact) and `apple/Tuist/Package.resolved` |
| NavigatorUI (package `Navigator`) | 1.4.6 | `apple/Tuist/Package.swift` (exact) and `apple/Tuist/Package.resolved` |

The machine provides the rest:

- **A JDK 17 to 23**, through `JAVA_HOME` or `java` on `PATH`: the Android Gradle
  plugin needs 17, and Gradle 8.13 runs on Java 23 at most (Java 24 needs Gradle
  8.14). The range belongs to the wrapper's Gradle and is written once in
  `scripts/verify` and once in `scripts/kmp-framework` (`java_gradle`,
  `minimum_java`, `maximum_java`); verify fails when the wrapper pins another
  Gradle, and `scripts/toolchain.test.mjs` when the two scripts differ, so a
  wrapper upgrade updates both. The build sets no JVM toolchain: it compiles to
  Java 17 bytecode on the JDK that runs Gradle.
- **Android SDK** with platform 36 and build tools 36.0.0, through `ANDROID_HOME`,
  `ANDROID_SDK_ROOT` or `sdk.dir` in `local.properties`.
- **An Apple silicon Mac with a full Xcode** whose SDKs cover iOS 26 and macOS 26.
  The shared modules have arm64 Apple targets only (`iosArm64`,
  `iosSimulatorArm64`, `macosArm64`). When `xcode-select -p` points at the Command
  Line Tools, export `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` in
  the shell instead of switching it. Kotlin 2.2.21 warns for every Xcode newer than
  16.0, the last version it knows; `gradle.properties` silences that warning and
  its comment says why.
- **SwiftLint** in the version `apple/.swiftlint.yml` pins (in the table above).
- **Node.js 22 or newer** for the architecture check.

On the BB host, `eval "$(bb device-lab env)"` exports `DEVELOPER_DIR`,
`JAVA_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT` and `PATH` for one shell.

## Open the projects

**Android Studio:** open `mobile/` itself, the Gradle root, not `android/`. The
app module is `:android:app`. Android Studio writes the SDK location to
`local.properties`, which stays untracked.

**Xcode:**

```
cd mobile/apple
tuist install
tuist generate
```

`tuist install` fetches the Swift packages pinned in
`apple/Tuist/Package.resolved`, and `tuist generate` writes the Xcode projects and
`apple/Semprec.xcworkspace` (all ignored) and opens the workspace (`--no-open`
skips that). Build, run and test the `Semprec` scheme on an iOS simulator or on
My Mac; the `SemprecUITests` scheme runs the XCUITest flows of
`apple/Projects/App/UITests/` on an iOS simulator only, because XCUITest on macOS
needs the Accessibility permission.

Every Xcode build runs Gradle through `scripts/kmp-framework`: CoreKit's "Build
the Kotlin framework" phase links `SharedSDK` for the selected SDK and
configuration into `shared/umbrella/build/xcode-frameworks/`, and the app's "Embed
the Kotlin framework" phase copies it into the app bundle and signs it when Xcode
signs the app. A change to the shared Kotlin code therefore reaches Swift on the
next Xcode build.

### Java for Xcode builds

`scripts/kmp-framework` needs a JDK 17 to 23 and looks for one in this order:
`JAVA_HOME`, which must run a Java of that range; then the newest JDK of the range
that `/usr/libexec/java_home` knows, asked for by version from 23 down to 17; then
`java` on `PATH`, which must run a Java of that range. Otherwise the build phase
fails with `no Java runtime found`, or with a message naming the Java it found out
of range. Xcode started from the Dock or
Finder does not inherit a shell's `JAVA_HOME`, and `/usr/libexec/java_home` does
not see a Homebrew JDK until it is registered. Either register the JDK, for
Homebrew's `openjdk@17`:

```
sudo ln -sfn /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk /Library/Java/JavaVirtualMachines/openjdk-17.jdk
```

or start Xcode, while it is not running, from a shell that has `JAVA_HOME`:
`open -a Xcode --env JAVA_HOME="$JAVA_HOME"`. `xcodebuild` and verify started from
such a shell inherit it and need nothing more. The same caveat, with the exact
error, is in [`docs/verify.md`](docs/verify.md).

## Verify

One command runs the whole mobile pipeline, from any directory:

```
mobile/scripts/verify [all|architecture|shared|android|apple]... [--ios-simulator <UDID>] [--android-serial <serial>]
```

Without a step name it runs `architecture`, `shared`, `android` and `apple` in that
order, stops at the first failing step and prints a PASS/FAIL summary. A step
that needs a device runs only when its flag is given, and the summary reports it as
NOT RUN otherwise; verify never picks, boots or shuts down a device. The `apple`
step builds Debug and Release for the iOS Simulator, an iOS device (no device or
signing needed) and macOS, builds the `SemprecUITests` UI tests for the iOS
Simulator without running them, and tests on macOS; `--ios-simulator` adds the
Swift tests and the `SemprecUITests` UI tests on that simulator. On the BB
host, reserve the devices with `bb device-lab reserve --platform ios` and
`bb device-lab reserve --platform android` (`bb device-lab list --json` shows each
device's `udid` and adb `serial`) and release them with
`bb device-lab release --all` when you are done. [`docs/verify.md`](docs/verify.md)
lists every step and prerequisite.

The Gradle tasks it runs also work on their own, from `mobile/`:

| Command | Runs |
| --- | --- |
| `./gradlew sharedJvmTest` | the common tests of every shared module on the JVM |
| `./gradlew sharedAppleTest` | the same tests natively on macOS; it fails on a host that is not an Apple silicon Mac |
| `./gradlew sharedAppleTest -Pmobile.iosSimulatorId=<UDID>` | also on the booted iOS simulator with that UDID. Requesting an `iosSimulatorArm64Test` task without the property, also through `check`, `allTests` or `build`, fails before any task runs |
| `./gradlew androidUnitTest` | `testDebugUnitTest` of every Android module |
| `./gradlew :android:app:lintDebug` | Android lint of the app and every module it depends on; any finding fails it |
| `./gradlew detektAll -PdetektAutoFix=false` | detekt with the formatting and Compose rules over `android/`, `shared/` and `build-logic/src`; without the property it also corrects formatting in place |
| `./gradlew :android:app:assembleDebug :android:app:assembleRelease` | the debug APK and the unsigned, R8-minified release APK |
| `ANDROID_SERIAL=<serial> ./gradlew :android:app:connectedDebugAndroidTest` | the instrumented tests on that device |

## Decisions, review rules and skills

- Architecture decisions:
  [monorepo holds backend, web and mobile](../docs/adr/2026-10-24-monorepo-holds-backend-web-and-mobile.md),
  [Kotlin Multiplatform below native mobile UI](../docs/adr/2026-10-24-kotlin-multiplatform-below-native-mobile-ui.md),
  [backend calls through the shared data layer](../docs/adr/2026-10-24-mobile-backend-calls-through-shared-data-layer.md),
  [shared screen ViewModel lifecycle and native hosting](../docs/adr/2026-10-24-shared-screen-viewmodel-lifecycle-and-native-hosting.md),
  [app-owned navigation through feature routers](../docs/adr/2026-10-24-app-owned-mobile-navigation-through-feature-routers.md),
  [copy localized natively from typed state](../docs/adr/2026-10-24-mobile-copy-localized-natively-from-typed-state.md).
- Review platforms: [`review-rules/`](review-rules/) for the shared Kotlin layer,
  the Gradle build, `build-logic/`, `config/`, `scripts/`, `docs/` and this file;
  [`android/review-rules/`](android/review-rules/) for the Android app;
  [`apple/review-rules/`](apple/review-rules/) for the iOS and macOS app. A file
  belongs to the platform whose directory is the longest prefix of its path.
- Agent skills in `.bb/skills/`: `shared-viewmodel`, `kmp-shared`,
  `android-compose`, `apple-swiftui`, `mobile-navigation`,
  `mobile-feature-create`, `mobile-verify`.
- [`apple/docs/auth-bridge.md`](apple/docs/auth-bridge.md): how the native app
  hands its session to the web editor embedded in a `WKWebView` (issue #141). The
  Swift side is not implemented yet.
