Check the build and the checks this platform owns: the Gradle root
(`settings.gradle.kts`, `build.gradle.kts`, `gradle.properties`, `gradle/`), the
convention plugins in `build-logic/`, `config/detekt/detekt.yml`, the scripts
under `scripts/` and their tests, and the documentation (`README.md`, `docs/`).
These are what every mobile pull request is built and judged with, locally,
in the `mobile-android` and `mobile-apple` CI jobs and in Relay's `verify-mobile`
step. A gate that quietly passes here passes for every later change. Report
nothing for shared Kotlin sources; the other tasks cover them.

1. A step that can end in success without having checked — in `scripts/`, in a
   root aggregate task (`sharedJvmTest`, `sharedAppleTest`, `androidUnitTest`,
   `detektAll`) or in a convention plugin: a missing prerequisite (JDK, Xcode,
   Android SDK, Tuist version, device id) skipped or reported as a pass instead
   of failing or being reported as not run; an exit status dropped (`|| true`,
   a removed `set -euo pipefail`, an unchecked child process); an aggregate
   that stops depending on a module's tests, or a test filter that matches no
   test and still succeeds; or Kotlin/Native allowed to skip the Apple
   targets on a host that cannot build them (`kotlin.native.ignoreDisabledTargets`)
   — high.
2. A rule of `scripts/architecture.mjs` added or changed without a `node:test`
   case that fails on a violating fixture and passes on the real tree — medium.
   A rule removed, or `scripts/architecture-policy.json` changed to allow an
   edge or import that the module graph of
   `docs/adr/2026-10-24-kotlin-multiplatform-below-native-mobile-ui.md` forbids,
   without the linked issue's Task calling for it — high: the policy is that
   graph in checkable form.
3. detekt weakened — a rule deactivated, a threshold raised, `excludes`
   widened, a baseline added, `ignoreFailures` set, or `-PdetektAutoFix=false`
   no longer read-only — without the Task calling for it — medium: every
   Kotlin module of both apps is held to that configuration.
4. A dependency or plugin version written into a build script instead of
   `gradle/libs.versions.toml`, a dynamic or range version (`+`,
   `latest.release`, `[1.0,2.0)`), or a catalog entry no build script uses —
   medium.
5. An identity, version or SDK value typed into a build script instead of read
   from `gradle/project.properties`, or one of its Apple values
   (`appleBundleId`, `frameworkName`, `versionName`, `versionCode`,
   `iosMinimum`, `macosMinimum`) changed without
   `apple/Tuist/ProjectDescriptionHelpers/ProjectConfiguration.swift` following
   — medium.
6. A change in `build-logic/` that alters every module at once — the Kotlin
   targets of `semprec.kmp`, the JVM target, the Kotlin/Native minimum OS
   override, the Android SDK levels — without the Task calling for it, or that
   drops a target an app needs (`androidTarget` for Android; `iosArm64`,
   `iosSimulatorArm64` and `macosArm64` for the Apple app) — high.
7. A build step or script that picks, boots or shuts down a simulator or an
   emulator itself instead of using the device the caller passes
   (`-Pmobile.iosSimulatorId`, or a device argument of `scripts/verify`) —
   high: devices on a build host belong to whoever reserved them, so a build
   that changes one breaks another run.
8. `scripts/kmp-framework` mapping an Xcode SDK or configuration to the wrong
   Gradle task or framework directory, or embedding the framework into a
   target other than the app — high: the app then links or ships a framework
   built for another platform or configuration. `scripts/toolchain.test.mjs`
   pins the task for `iphoneos`, `iphonesimulator` and `macosx` in Debug and
   Release and the embed folder check, so a change to the mapping comes with a
   case there (medium without one). The `apple` step of `scripts/verify`
   builds for `generic/platform=iOS` so that the `iphoneos` branch runs at all,
   and builds the `SemprecUITests` target for the iOS Simulator so that a UI
   test that no longer compiles fails without a device; a verify that stops
   running either build, or the `SemprecUITests` run with `--ios-simulator`, and
   still passes is item 1.
9. A machine-specific path (a JDK, SDK or home directory) committed in a build
   file or script — medium: the build must work from a clean checkout with
   whichever JDK of the supported range (17 to 23 for Gradle 8.13) runs Gradle.
10. A sentence in `README.md` or `docs/` that states a command, path, task,
    module or behavior the code does not have — medium: implementers and
    reviewers act on these documents as fact.
