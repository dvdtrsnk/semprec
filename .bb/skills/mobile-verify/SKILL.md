---
name: mobile-verify
description: "How a change under mobile/ is built, tested, linted and reported - the entry point mobile/scripts/verify with its architecture, shared, android and apple steps, the Gradle, Tuist, xcodebuild and SwiftLint commands behind it, reserving a simulator or emulator through bb device-lab and passing it in, and reporting every step as PASS, FAIL or NOT RUN as it happened. Load this BEFORE running or claiming any mobile build, test or lint, and before a pull request that touches mobile/. Triggers on: mobile/scripts/verify, --ios-simulator, --android-serial, architecture.mjs, architecture-policy.json, ./gradlew, sharedJvmTest, sharedAppleTest, androidUnitTest, detektAll, lintDebug, connectedDebugAndroidTest, -Pmobile.iosSimulatorId, tuist generate, xcodebuild, SemprecUITests, swiftlint, DEVELOPER_DIR, JAVA_HOME, bb device-lab, a UDID, an adb serial, a Gradle lock timeout, and claims such as tests pass or verified. Skip only when nothing under mobile/ changed and nothing about mobile is claimed."
---

# One command verifies mobile/. Report exactly what it ran.

No job in `.github/workflows/ci.yml` builds or tests `mobile/`, and Relay's
verify steps run `pnpm run verify` in `backend/` and `web/` only. A local run
of `mobile/scripts/verify` is therefore the only build and test of a mobile
change before it is reviewed and merged. Why honest reporting matters here: an
agent that writes "tests pass" for a step that did not run leaves nobody else
to notice.

## 1. The entry point

```
mobile/scripts/verify [all|architecture|shared|android|apple]... [--ios-simulator <UDID>] [--android-serial <serial>]
```

It runs from any directory and finds `mobile/` itself. Without a step name it
runs `all`, which is `architecture shared android apple` in that order. The
first failing command stops the run, and every later command is listed as NOT
RUN. It prints a summary with PASS, FAIL or NOT RUN for every command and
exits non-zero on a failure. A missing prerequisite fails its step with a
message naming what is missing; nothing is ever skipped silently. The device
commands run only when their flag is given, and the summary reports them as
NOT RUN otherwise. Each command's output goes to a log under
`mobile/build/verify/<run>/`, and each Swift test run leaves its result bundle
next to its log.

| Step | Runs |
|---|---|
| `architecture` | `node mobile/scripts/architecture.mjs` (the rules below) and `node --test` over `mobile/scripts/*.test.mjs` (`architecture.test.mjs` for the rules; `toolchain.test.mjs` for verify's JDK and SwiftLint checks and the `xcodebuild` calls of its `apple` step, and for `kmp-framework`'s JDK lookup, its Gradle task per SDK and configuration and its embed folder check) |
| `shared` | `./gradlew sharedJvmTest sharedAppleTest detektAll -PdetektAutoFix=false`; with `--ios-simulator`, also `-Pmobile.iosSimulatorId=<UDID>`. Needs an Apple silicon Mac |
| `android` | `./gradlew :android:app:assembleDebug :android:app:assembleRelease androidUnitTest :android:app:lintDebug`; with `--android-serial`, also `connectedDebugAndroidTest` on that device |
| `apple` | the Tuist version must equal `mobile/apple/.tuist-version` and the SwiftLint version `swiftlint_version` in `mobile/apple/.swiftlint.yml`; `swiftlint lint --strict`; `tuist install`; `tuist generate --no-open`; `xcodebuild build` of the `Semprec` scheme, Debug and Release, for `generic/platform=iOS Simulator`, `generic/platform=iOS` (the iPhone build, which links the `iosArm64` Kotlin framework and needs no device) and `generic/platform=macOS`, with `CODE_SIGNING_ALLOWED=NO`; `xcodebuild build-for-testing` of the `SemprecUITests` scheme for `generic/platform=iOS Simulator` (no device); `xcodebuild test` of the `Semprec` scheme on `platform=macOS,arch=arm64`; with `--ios-simulator`, also `xcodebuild test` of the `Semprec` scheme and then of the `SemprecUITests` scheme (XCUITest, iOS only) on that simulator |

`mobile/docs/verify.md` describes every step and prerequisite in detail.

detekt runs in the `shared` step and covers `android/`, `shared/` and
`build-logic/src`. A Kotlin change under `mobile/android/` therefore needs
`shared android`, not `android` alone.

The architecture rules (`mobile/scripts/architecture.mjs`, policy in
`mobile/scripts/architecture-policy.json`): `ARCH-GRADLE`, `ARCH-APPLE`,
`KMP-COMMON`, `KMP-FRAMEWORK`, `VM-BRIDGE`, `NAV-OWNERSHIP`, `APPLE-IDENTITY`,
`ORG-SCREEN`, `COPY-PARITY` and `WRAPPER`. A failure names its rule id; the
topic skill that owns the rule says how to fix the code (`kmp-shared`,
`shared-viewmodel`, `mobile-navigation`, `android-compose`, `apple-swiftui`,
`canonical-keys`). Change the policy only when the issue adds the module, key
or edge it describes (`mobile-feature-create`), never to make a finding go away.

## 2. Environment on this Mac

- `eval "$(bb device-lab env)"` exports `DEVELOPER_DIR` (the full Xcode),
  `JAVA_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT` and `PATH` for one shell.
- `xcode-select` points at the Command Line Tools, not at the full Xcode in
  `/Applications/Xcode.app`. `verify` exports
  `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` for its run when
  `xcodebuild -version` fails; when you run Kotlin/Native's Apple tasks,
  `tuist`, `xcodebuild` or `swiftlint` yourself, export it first. Never run
  `sudo xcode-select`.
- `JAVA_HOME` must point at a JDK 17 to 23, or `java` on `PATH` must run one:
  the Android Gradle plugin needs 17 and Gradle 8.13 runs on Java 23 at most,
  so `verify` fails up front on a newer JDK. Homebrew's unversioned `openjdk`
  is newer than 23 today; use `openjdk@17` or `openjdk@21`. The range is
  written once in `mobile/scripts/verify` and once in
  `mobile/scripts/kmp-framework`, and a wrapper upgrade changes both. Android
  needs `ANDROID_HOME`, `ANDROID_SDK_ROOT` or `mobile/local.properties`. The
  architecture step needs Node.js 22 or newer.
- SwiftLint must be the version `swiftlint_version` in
  `mobile/apple/.swiftlint.yml` pins (0.65.1); `verify` fails on another one,
  and SwiftLint itself refuses to lint with that configuration.
- Other agents and Relay build on this host at the same time. On a Gradle lock
  timeout, wait and run again. Never kill a process you did not start, and
  never select processes by name (`.bb/AGENTS.md`). Write scratch output into
  an ignored `build/` directory of your worktree or a `mktemp` path.

## 3. Devices: reserve, pass in, release

`verify` and the Gradle build never pick, boot or shut down a device. You
reserve one for your thread and pass its id:

1. `bb device-lab reserve --platform ios` and
   `bb device-lab reserve --platform android` reserve and boot a device;
   `bb device-lab status` shows what your thread holds, and
   `bb device-lab list --json` shows each device's `udid` and adb `serial`.
2. Pass them: `mobile/scripts/verify --ios-simulator <UDID> --android-serial <serial>`.
3. `bb device-lab release --all` when you are done, also after a failure.

Never touch a device another thread reserved. Why: the user watches and
drives reserved devices live, and another agent's test run is on them.

Gradle's `iosSimulatorArm64Test` tasks run only with
`-Pmobile.iosSimulatorId=<UDID>`; requested without it, also through `check`,
`allTests` or `build`, the build fails before any task runs.
`ANDROID_SERIAL=<serial> ./gradlew :android:app:connectedDebugAndroidTest`
runs the instrumented tests on one device.

## 4. A focused loop, then the full run

While iterating, run the narrowest command that exercises your change, from
`mobile/` (or `mobile/apple/` for Tuist and Xcode):

| Change | Fast check |
|---|---|
| shared Kotlin | `./gradlew sharedJvmTest`, then `./gradlew sharedAppleTest` |
| exported shared API | add `./gradlew :shared:umbrella:linkDebugFrameworkIosSimulatorArm64 :shared:umbrella:linkDebugFrameworkMacosArm64` and the `apple` step |
| Android Kotlin or resources | `./gradlew androidUnitTest :android:app:lintDebug` |
| any Kotlin formatting | `./gradlew detektAll` corrects formatting in place (read `git diff` afterwards and keep only what you would have written); `./gradlew detektAll -PdetektAutoFix=false` only reports, as `verify` does |
| Swift | `swiftlint lint --strict`, then `tuist generate --no-open` and `xcodebuild test -workspace Semprec.xcworkspace -scheme Semprec -destination 'platform=macOS,arch=arm64' -derivedDataPath build/DerivedData` |
| Apple UI flows | `xcodebuild test -workspace Semprec.xcworkspace -scheme SemprecUITests -destination id=<UDID> -derivedDataPath build/DerivedData` on a simulator you reserved; the `Semprec` scheme neither builds nor runs `SemprecUITests` |
| a module, a manifest or the policy | `mobile/scripts/verify architecture` |

Before a pull request that touches `mobile/`, run the full pipeline from the
repository root with both devices reserved:

```
mobile/scripts/verify --ios-simulator <UDID> --android-serial <serial>
```

`.bb/AGENTS.md` asks for the same run. If a device cannot be reserved, run
without its flag and report that step as NOT RUN.

A change to what a screen does also needs it exercised on a device: the
instrumented `SmokeFlowTest` on Android, and on Apple `SmokeFlowTests` of
`SemprecUITests` on the reserved iOS simulator (the `apple` step runs it with
`--ios-simulator`). A flow those tests do not walk gets a case there, or the
app installed and driven on the reserved simulator (`bb device-lab install`,
`launch`, `tap`, `screenshot`, `describe`); the `apple` step builds the Debug
simulator app into
`mobile/apple/build/DerivedData/Build/Products/Debug-iphonesimulator/Semprec.app`.
No UI test runs on macOS, because macOS XCUITest needs the Accessibility
permission: there `AppSceneNavigationTests` drive the shown scene in process,
and the macOS app's runtime is otherwise not verified unless you launched and
looked at it. For a screen backed by a shared ViewModel, open it, leave it and
open it again: the second presentation must show content, not stay loading.
Find elements by their test identifiers, not by localized text or
coordinates.

## 5. Reporting

- Report each step as the summary printed it: PASS, FAIL or NOT RUN. A device
  step without its flag is NOT RUN, never "passed".
- Give test counts per suite (JVM, macOS native, iOS simulator native, Android
  unit, Android instrumented, Swift on macOS, Swift on the simulator, Apple UI
  tests on the simulator). A run that executed zero tests is not a pass.
- Compilation, linking, tests and runtime are separate evidence. A Swift
  type-check is not an Apple build, a built test APK is not a run test, and an
  iOS run says nothing about the macOS app at runtime.
- Name the exact command, its exit status and where its log or result bundle
  is (`verify` prints the path of each).

## 6. Fixing failures

- Read the first failure and group the rest by their first cause before you
  change anything; a broken module edge or an untranslated string cascades.
- Fix within the issue's scope. Never add a feature-to-feature dependency,
  delete or weaken a test, or add a lint exception to get green.
- No detekt baseline, no raised threshold, no disabled rule, and no
  `@Suppress` without a one-line reason; no `swiftlint:disable` and no edit to
  `mobile/apple/.swiftlint.yml`; no new `disable` entry in the app's `lint { }`
  block. Each needs an explicit decision in the issue. Why: a suppression
  silences every future instance of the finding, not just yours.
- After three runs that bring no new evidence, stop and report the blocker
  with the failing output rather than retrying.

## Before committing, check

- [ ] The full `mobile/scripts/verify` ran for a change under `mobile/`, with
      devices reserved through `bb device-lab` or the missing device step
      reported as NOT RUN.
- [ ] Every device you reserved is released.
- [ ] The report lists each step as PASS, FAIL or NOT RUN, with test counts and
      no zero-test pass.
- [ ] No suppression, baseline, threshold or policy change was added to get a
      check green.
