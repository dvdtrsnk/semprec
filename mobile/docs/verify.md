# Verifying the mobile platform

`mobile/scripts/verify` builds, tests and checks everything under `mobile/`. It is a
bash script; the architecture check it runs is a dependency-free Node.js script.

```
mobile/scripts/verify [all|architecture|shared|android|apple]... [--ios-simulator <UDID>] [--android-serial <serial>]
```

- It runs from any directory: it finds `mobile/` from its own location.
- Without a step name it runs `all`, which is `architecture shared android apple`.
  Named steps always run in that order, whatever order they are given in.
- The first failing command stops the run. Every later command is listed as
  NOT RUN ("an earlier command failed").
- Each step first checks its prerequisites and fails, naming every missing one,
  when something is missing. Nothing is skipped silently.
- `--ios-simulator` and `--android-serial` add the device commands. Without its flag
  a device command is listed as NOT RUN ("pass --ios-simulator <UDID> to run it";
  the UI test row adds "SemprecUITests runs on iOS only").
  A flag whose steps are not selected (`verify android --ios-simulator …`) is a usage
  error.
- Exit status: 0 when every command that ran passed, 1 when one failed, 2 for a
  usage error. `--help` prints the steps and flags.

## Output

Before each command verify prints the command, its working directory and its log
file, then PASS or FAIL with the wall-clock time. On a failure it prints the last
40 lines of the log. Each run writes its logs to `mobile/build/verify/<date>-<time>-<pid>/`,
one numbered file per command. A Swift test run also leaves its result bundle there,
named like its log with `.xcresult` instead of `.log`, and the bundle's summary next
to it (`….xcresult.summary.json`). The run ends with a summary like this one,
from `verify all` with a reserved iOS simulator and Android emulator (without a
device flag, its device commands are listed as NOT RUN instead):

```
== verify summary (logs in mobile/build/verify/20261024-065407-17265)
PASS     architecture   9s
  PASS     prerequisites                                              0s  Node.js v26.12.1
  PASS     architecture.mjs                                           1s
  PASS     node --test scripts/*.test.mjs                             8s
PASS     shared         2s
  PASS     prerequisites                                              0s  JDK 21.0.13 (JAVA_HOME), macOS 27.0.1 arm64, Xcode 27.1, iOS simulator 9A12AA8B-70CF-4D3F-82AE-3CE5AB759558 (booted)
  PASS     gradle shared tests + detekt, iOS simulator included       2s
PASS     android        36s
  PASS     prerequisites                                              0s  JDK 21.0.13 (JAVA_HOME), Android SDK /Users/davidtresnak/Library/Android/sdk (ANDROID_HOME), Android device emulator-5554
  PASS     gradle assemble + unit tests + lint                        1s
  PASS     connectedDebugAndroidTest on emulator-5554                35s
PASS     apple          3m 14s
  PASS     prerequisites                                              0s  macOS 27.0.1 arm64, Xcode 27.1, JDK 21.0.13 (JAVA_HOME), Tuist 4.213.0, SwiftLint 0.65.1, iOS simulator 9A12AA8B-70CF-4D3F-82AE-3CE5AB759558 (booted)
  PASS     swiftlint lint --strict                                    0s
  PASS     tuist install                                              0s
  PASS     tuist generate --no-open                                   0s
  PASS     build Debug, iOS Simulator                                15s
  PASS     build Debug, iOS device                                   13s
  PASS     build Debug, macOS                                        13s
  PASS     build Release, iOS Simulator                              13s
  PASS     build Release, iOS device                                 13s
  PASS     build Release, macOS                                      13s
  PASS     build the UI tests, iOS Simulator                         13s
  PASS     test on macOS                                             21s  56 tests passed
  PASS     test on iOS simulator 9A12AA8B-70CF-4D3F-82AE-3CE5AB759558      22s  54 tests passed
  PASS     UI tests on iOS simulator 9A12AA8B-70CF-4D3F-82AE-3CE5AB759558      58s  3 tests passed
verify: PASS in 4m 2s
```

Each step line carries the step's result and its total time. A step is NOT RUN when
an earlier step failed before it started.

## Steps

| Step | Prerequisites checked | Commands, in order |
| --- | --- | --- |
| `architecture` | Node.js 22 or newer | `node scripts/architecture.mjs`; `node --test` on every `scripts/*.test.mjs` (fails when there is none): `architecture.test.mjs` for the architecture rules; `toolchain.test.mjs` for the JDK and SwiftLint prerequisites of verify, the `xcodebuild` calls of verify's `apple` step against stand-in tools (the six builds in order, the build of the UI tests for the iOS Simulator, the macOS test, the simulator test and UI test runs with `--ios-simulator`, their NOT RUN rows without it, and a UI test run that passes no test failing), the JDK lookup of `kmp-framework`, the Gradle task `kmp-framework --build-only` runs for `iphoneos`, `iphonesimulator` and `macosx` in Debug and Release, its `--embed` folder check (`.app/Frameworks` against `.app/Contents/Frameworks`, a target that is no app refused) and its refusal of an SDK, configuration or architectures it builds no framework for |
| `shared` | a JDK 17 to 23, macOS on Apple silicon, Xcode; with `--ios-simulator`, that simulator booted | `./gradlew sharedJvmTest sharedAppleTest detektAll -PdetektAutoFix=false`, plus `-Pmobile.iosSimulatorId=<UDID>` with `--ios-simulator` |
| `android` | a JDK 17 to 23, Android SDK; with `--android-serial`, that device running | `./gradlew :android:app:assembleDebug :android:app:assembleRelease androidUnitTest :android:app:lintDebug`; with `--android-serial`, `ANDROID_SERIAL=<serial> ./gradlew connectedDebugAndroidTest` |
| `apple` | macOS on Apple silicon, Xcode, a JDK 17 to 23, `tuist version` equal to `apple/.tuist-version`, `swiftlint version` equal to `swiftlint_version` in `apple/.swiftlint.yml`; with `--ios-simulator`, that simulator booted | `swiftlint lint --strict`; `tuist install`; `tuist generate --no-open`; `xcodebuild build` of the `Semprec` scheme for Debug and Release, each for `generic/platform=iOS Simulator`, `generic/platform=iOS` and `generic/platform=macOS`, with `CODE_SIGNING_ALLOWED=NO`; `xcodebuild build-for-testing` of the `SemprecUITests` scheme for `generic/platform=iOS Simulator`, with `CODE_SIGNING_ALLOWED=NO`; `xcodebuild test` of the `Semprec` scheme on `platform=macOS,arch=arm64`; with `--ios-simulator`, `xcodebuild test` of the `Semprec` scheme on `id=<UDID>`, then `xcodebuild test` of the `SemprecUITests` scheme on `id=<UDID>` |

The Gradle commands run in `mobile/`, the architecture commands in `mobile/` and
the Apple commands in `mobile/apple/`.

- `shared`: `sharedJvmTest` runs the common tests of every shared module on the
  JVM, `sharedAppleTest` runs them natively on macOS (and on the simulator with
  the property), and `detektAll` checks `android/`, `shared/` and `build-logic/src`.
  A Kotlin change under `android/` therefore needs `shared android`, not `android`
  alone.
- `android`: `androidUnitTest` is `testDebugUnitTest` of every Android module. Lint
  of the app also checks every module it depends on. `connectedDebugAndroidTest`
  runs the instrumented tests of every module that has any, on the device
  `ANDROID_SERIAL` names.
- `apple`: every `xcodebuild` uses `-workspace Semprec.xcworkspace` and
  `-derivedDataPath mobile/apple/build/DerivedData`, so the runs share one build,
  and `-scheme Semprec`, except the build and the run of the UI tests, which use
  `-scheme SemprecUITests`.
  The builds run the Kotlin framework phase of CoreKit, which builds `SharedSDK` with
  Gradle through `scripts/kmp-framework`. `generic/platform=iOS` is the build for an
  iPhone or iPad: the `iphoneos` SDK, which links the `iosArm64` Kotlin framework
  through the `iphoneos` branch of `kmp-framework`; it needs no device and, with
  `CODE_SIGNING_ALLOWED=NO`, no signing team. A test command, the UI test run
  included, passes only when its result bundle reports at least one passed test
  and no failed one.
- The `Semprec` scheme builds the app and runs the four unit test bundles; it does
  not build the iOS-only `SemprecUITests` target. verify therefore builds that
  target on its own, with `xcodebuild build-for-testing` for `generic/platform=iOS
  Simulator`, which needs no device: a UI test that no longer compiles fails every
  run. Running the UI tests needs `--ios-simulator`.

## Prerequisites

| Prerequisite | Needed by | How verify finds and checks it |
| --- | --- | --- |
| Node.js 22 or newer | `architecture` | `node` on `PATH`, major version from `node --version` |
| A JDK 17 to 23 | `shared`, `android`, `apple` | `$JAVA_HOME/bin/java` when `JAVA_HOME` is set, otherwise `java` on `PATH`; the version from `java -version` must be 17 to 23, because the Android Gradle plugin needs 17 and Gradle 8.13 runs on Java 23 at most (Java 24 needs Gradle 8.14). The range is `java_gradle`, `minimum_java` and `maximum_java` near the top of `scripts/verify`, and the same three lines in `scripts/kmp-framework`. verify fails when `gradle/wrapper/gradle-wrapper.properties` pins another Gradle than `java_gradle`, and `scripts/toolchain.test.mjs` fails when the two scripts differ, so a wrapper upgrade updates the range in both. The `apple` builds run Gradle from Xcode's Kotlin framework phase |
| macOS on Apple silicon | `shared`, `apple` | `uname -s` is `Darwin` and `uname -m` is `arm64`. The Kotlin framework and the Apple builds are arm64 only, and `sharedAppleTest` runs the native macOS tests |
| Xcode | `shared`, `apple` | `xcodebuild -version` succeeds. When it fails (for example because `xcode-select` points at the Command Line Tools) and `/Applications/Xcode.app/Contents/Developer` exists, verify exports that directory as `DEVELOPER_DIR` for its own run and says so; it never runs `xcode-select`. Xcode elsewhere: export `DEVELOPER_DIR=<Xcode.app>/Contents/Developer` yourself |
| Android SDK | `android` | the first of `sdk.dir` in `mobile/local.properties`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`; the directory must exist. `mobile/local.properties` is ignored by Git |
| Tuist, the version in `mobile/apple/.tuist-version` | `apple` | `tuist` on `PATH`, and the last line of `tuist version` equals the pinned version |
| SwiftLint, the version in `mobile/apple/.swiftlint.yml` | `apple` | `swiftlint` on `PATH`, and `swiftlint version` equals the one exact version of the top-level `swiftlint_version` key (0.65.1); a missing key, or a value that is not one exact version, fails too. SwiftLint itself also stops with an error under any other version when it reads that configuration |

On the BB Mac mini, `eval "$(bb device-lab env)"` exports `DEVELOPER_DIR`,
`ANDROID_HOME`, `ANDROID_SDK_ROOT`, `JAVA_HOME` and the Android tools on `PATH` for
the current shell.

verify's Gradle commands use the Gradle daemon, which other builds on the same
machine share. On a Gradle lock timeout, wait and run again.

## Devices

verify never picks, boots or shuts down a simulator or emulator. You start the
device, pass its id, and stop it afterwards:

- `--ios-simulator <UDID>`: the simulator must be booted (`xcrun simctl list devices`
  shows it as `(Booted)`). The `shared` step adds `-Pmobile.iosSimulatorId=<UDID>`,
  so `sharedAppleTest` also runs `iosSimulatorArm64Test` on it, and the `apple` step
  runs `xcodebuild test -destination id=<UDID>` of the `Semprec` scheme and then of
  the `SemprecUITests` scheme, which installs and drives the app through XCUITest.
- `--android-serial <serial>`: `adb -s <serial> get-state` must answer `device`
  (verify uses the SDK's `platform-tools/adb`, or `adb` on `PATH`). The `android`
  step then runs `connectedDebugAndroidTest` with `ANDROID_SERIAL=<serial>`.

On the BB Mac mini a thread reserves its devices through Device Lab:

```
bb device-lab reserve --platform ios        # reserves and boots a simulator, prints its UDID
bb device-lab reserve --platform android    # reserves and boots an emulator
bb device-lab status                        # the devices this thread holds, with the adb serial
mobile/scripts/verify --ios-simulator <UDID> --android-serial <serial>
bb device-lab release --all                 # release them, also after a failure
```

Never pass a device another thread has reserved.

## Architecture rules

`mobile/scripts/architecture.mjs` checks the rules below, from any working directory
and also when it is run through a symlinked path, and prints `ok` or `FAIL` for each, with every violation as `<file>:<line>: <message>` (without `:<line>` when
the violation concerns a whole file). It reads source text
(imports, `project(...)` calls, Tuist target declarations, class declarations) with
regular expressions over the code with its comments removed; it does not compile
anything. What the rules allow is `mobile/scripts/architecture-policy.json`:

- `gradle.modules`: each Gradle module and the modules it may depend on;
- `kotlinCommon.allowedImports`: the platform imports `commonMain` may use;
- `apple.targets`: each Tuist target, its project directory, its source directory
  (`Sources`, `Tests` or `UITests`) and the modules it may depend on and import; an
  `allowed` list that names the Kotlin framework (`SharedSDK`, only `CoreKitTests`
  today) lets that target import it. A UI test target names its app in
  `appUnderTest` (`SemprecUITests`: `Semprec`): it may depend on that app, which
  Tuist makes the application the tests launch, but may not import it or any of its
  modules, and `allowed` (empty for `SemprecUITests`) governs everything else;
  `apple.systemModules` and `apple.externalModules`; `apple.kotlinFrameworkTarget`;
- `viewModels`: the shared presentation module, the ViewModel base class and the
  lease type of the CoreKit bridges;
- `navigation`: the Gradle modules and Apple targets that own navigation;
- `copy`: the copy keys of each module pair, with the Android-only and the
  untranslatable Android strings.

A policy change is an architecture change: make it in the change that adds the
module, edge or key, never to make a finding go away.
`mobile/scripts/architecture.test.mjs` proves each rule: it passes on the real tree
and fails on a copy of the tree with one violation added.

| Id | Rule | How to fix |
| --- | --- | --- |
| `ARCH-GRADLE` | Every module `settings.gradle.kts` includes has an entry in `gradle.modules`, and every entry is included. Every `project(":…")` in a module's `build.gradle.kts` is in its entry. The project dependencies form no cycle. | Depend only on what the entry allows; code two features both need moves down into `:android:core:ui` or the shared layers. A new module gets its entry in the change that includes it. |
| `ARCH-APPLE` | Every target a `Project.swift` declares (`SemprecProject.framework`, `SemprecProject.tests`, `.target(name:…, product:…)`) has an entry in `apple.targets` for that project directory, and every entry is declared. Every `.project(target:path:)`, `.target(name:)` and `.external(name:)` dependency is in the target's `allowed` or is its `appUnderTest`, names a listed target at its project path or an external module, and has a name the check can resolve. An `appUnderTest` names a listed target, and the UI test target depends on it. Every `import` in the target's sources is a system module, the Kotlin framework (checked by `KMP-FRAMEWORK`), or an allowed target or external module that the manifest declares; Xcode would otherwise build an undeclared import only by accident of the shared workspace. The app under test is never allowed as an import. Every entry of a `.target(...)`'s `sources:` outside its policy `sources` directory must be one existing `.swift` file, and that file's imports are checked against the policy of the target that compiles it, an import of the Kotlin framework included; a glob outside the directory, a missing file and a source path the check cannot resolve fail. | Declare the dependency in `Project.swift` and allow it in `apple.targets`, if the module graph permits that edge. Add a new system framework to `apple.systemModules`. A UI test finds elements by identifiers and launches the app; it compiles the identifier files it needs one by one instead of importing their module. |
| `KMP-COMMON` | No file in any module's `src/commonMain` imports a name starting with `android.`, `androidx.`, `java.`, `javax.`, `platform.` or `kotlinx.cinterop.`, except the exact names in `kotlinCommon.allowedImports` (`androidx.lifecycle.ViewModel`, `androidx.lifecycle.viewModelScope`). | Use a multiplatform API, or keep the platform code in the native app. |
| `KMP-FRAMEWORK` | Only Swift files below the sources of `apple.kotlinFrameworkTarget` and of every `apple.targets` entry whose `allowed` lists the framework import the framework named by `frameworkName` in `gradle/project.properties` (`SharedSDK`). The policy lists it for `CoreKitTests` only, so the import is allowed exactly in `apple/Modules/Core/CoreKit/Sources/` and `apple/Modules/Core/CoreKit/Tests/`, and fails everywhere else, the other targets' tests included. | Use CoreKit's Swift types (the `*ScreenModel` protocols and their value types); new Kotlin API gets a bridge in CoreKit. |
| `VM-BRIDGE` | A screen ViewModel is a class in the `commonMain` of `:shared:presentation` that extends `ScreenViewModel` directly or through other classes declared there (resolved transitively, cycle-safe). Every non-abstract one has a `<Name>Test.kt` in `shared/presentation/src/commonTest`, exactly one class in CoreKit's sources that stores it in a property, and an Android `*Screen` composable (in some module's `src/main`) that takes it as a parameter. Every class in CoreKit's sources that stores `ScreenViewModel`, any screen ViewModel (abstract or not) or a `SharedViewModelLease` holds a `SharedViewModelLease` and calls `close()` on it in `deinit`. | Add the missing test, bridge or screen; a bridge holds a `SharedViewModelLease` and closes it in `deinit`. |
| `NAV-OWNERSHIP` | Outside `navigation.gradleModules` (`:android:app`), no Kotlin file imports `androidx.navigation.*` or uses `NavController` or `NavHostController`; in `:android:app`, no ViewModel file does (a file named `*ViewModel.kt`, or one declaring a class that extends `ViewModel` or `ScreenViewModel` directly or through other classes declared in any Gradle module's Kotlin sources). Outside `navigation.appleTargets` (`Semprec` and `SemprecTests`, whose tests drive the app's NavigatorUI stacks), no Swift file imports `NavigatorUI`; in those targets, no `*ViewModel.swift` does. | The feature declares a router (`HomeRouter`, `HomeRouting`) and its effects call it; the app implements the router on its own navigation stacks. |
| `APPLE-IDENTITY` | `appleBundleId`, `frameworkName`, `versionName`, `versionCode`, `iosMinimum` and `macosMinimum` exist in `gradle/project.properties` and as `static let` in `apple/Tuist/ProjectDescriptionHelpers/ProjectConfiguration.swift`, with equal values. | Change both files in the same change. |
| `ORG-SCREEN` | Android: a `<X>Screen.kt` directly in a `presentation/screen/<folder>/` has `<X>ScreenLayout.kt` next to it. Apple: a `<X>ViewModel.swift` directly in a folder below a `Screens/` directory has `<X>Screen.swift` next to it. A screen without a ViewModel, such as About, is a layout or view only. The rule looks into no other folder: a `<X>Screen.kt`, `<X>Screen.swift` or `<X>ViewModel.swift` anywhere else passes it, and the review checks where screen files sit (`tasks/architecture.md` of each app's review rules). | Move the stateless layout into `<X>ScreenLayout.kt`; add the screen's view as `<X>Screen.swift`. |
| `COPY-PARITY` | Android: the check reads every `src/<sourceSet>/res` of every Gradle module except the test source sets (a source set whose camelCase name contains the word `test`: `test`, `androidTest`, `androidUnitTest`, `commonTest`, …). Copy lives only in `src/main/res`, and in `src/androidMain/res` of a Kotlin Multiplatform module (one with `src/commonMain`), which every build compiles; a string resource in any other source set's `res` (`debug`, `release`, `androidDebug`, the `androidMain` of a plain Android module, …) fails. For each `copy` entry, `values/*.xml` of those directories (merged) holds exactly its keys (dots replaced by underscores), its `androidOnly` keys and its `androidUntranslatable` names. Each key has a non-blank English value and a present, non-blank Czech value in `values-cs`; each untranslatable name carries `translatable="false"` and a non-blank value; `values-cs` holds nothing `values` lacks. Blank means empty, whitespace or markup only, a quoted `""`, a self-closing element, or a `<plurals>`/`<string-array>` with no item or a blank item. Apple: every String Catalog of the entry's target (`Resources/*.xcstrings`) has `sourceLanguage` `en`, its keys are exactly the entry's keys, and each key has a translated (state `translated`, in every variation), non-blank `en` value and `cs` value; an `androidOnly` key there fails. Every Android module with a string resource in any non-test `values*` directory and every String Catalog belongs to a `copy` entry. | Add a key to the Android and the Apple resources and to `copy` in the same change, with its English and Czech text, in `src/main/res` on Android. |
| `WRAPPER` | The SHA-256 of `gradle/wrapper/gradle-wrapper.jar` equals the first word of `gradle/wrapper/gradle-wrapper.jar.sha256`. | After a Gradle upgrade, check the new jar against the wrapper checksum Gradle publishes for that version, then write `shasum -a 256 gradle/wrapper/gradle-wrapper.jar` into the `.sha256` file. |

## Xcode started from Finder or the Dock has no JAVA_HOME

The Kotlin framework phases of the Apple targets run `mobile/scripts/kmp-framework`,
which runs Gradle on a JDK 17 to 23, the range `scripts/verify` checks too. It
finds Java in this order:

1. `JAVA_HOME`, which must run Java 17 to 23; otherwise the build fails
   (`JAVA_HOME is '<path>', which runs Java N; the build runs only on JDK 17 to 23 …`).
2. Without `JAVA_HOME`, `/usr/libexec/java_home -v 23`, then `-v 22` and so on down
   to `-v 17`: the first JDK whose runtime reports a version in the range.
   `java_home` without `-v` would return the newest registered JDK of any version.
3. Then `java` on `PATH`, which must run Java 17 to 23.

An app started from Finder, the Dock or Spotlight does not get the variables your
shell profile sets, and its `PATH` does not contain Homebrew. A JDK installed with
Homebrew is not registered with `/usr/libexec/java_home` either, and the macOS
`/usr/bin/java` stub runs no Java without one. A build from such an Xcode then fails
in the phase "Build the Kotlin framework" with:

```
error: kmp-framework: no Java runtime found; set JAVA_HOME to a JDK 17 to 23 (the Android Gradle plugin needs 17, Gradle 8.13 runs on 23 at most), register one with /usr/libexec/java_home, or put one on PATH
```

When `java` on `PATH` runs a Java outside the range, the message names it instead:
`JAVA_HOME is not set, /usr/libexec/java_home knows no JDK 17 to 23 (…), and java on PATH (<path>) runs Java N; …`.

`xcodebuild` and verify started from a terminal inherit the shell's `JAVA_HOME` and
`PATH` and are not affected. For Xcode itself, either:

- register the JDK so that `/usr/libexec/java_home` finds it; for Homebrew's
  `openjdk@17` that is
  `sudo ln -sfn /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk /Library/Java/JavaVirtualMachines/openjdk-17.jdk`
  (from `brew info openjdk@17`); or
- start Xcode, while it is not running, with the variable:
  `open -a Xcode --env JAVA_HOME="$JAVA_HOME"` (`--env` adds a variable to the
  environment of the launched app, `man open`).
