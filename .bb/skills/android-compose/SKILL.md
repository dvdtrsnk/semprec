---
name: android-compose
description: "How the Android app under mobile/android is written - a wiring XScreen and a stateless XScreenLayout over the shared ViewModel, StatusView for loading, empty and failure, copy from the module's strings.xml in en and cs, tags from the per-module *TestTags objects, private previews, and the lint, detekt and device checks. Load this BEFORE writing or changing a composable, a string resource, a test tag or an Android build file. Triggers on: mobile/android/, @Composable, *Screen.kt, *ScreenLayout.kt, collectAsStateWithLifecycle, CollectEffects, koinViewModel, @Preview, LazyColumn, Modifier.testTag, testTagsAsResourceId, StatusTestTags, HomeTestTags, SettingsTestTags, AppTestTags, StatusView, failureMessage, AppTheme, stringResource, R.string, values/strings.xml, values-cs/strings.xml, semprec.android.compose, semprec.android.application, androidUnitTest, lintDebug, connectedDebugAndroidTest, SmokeFlowTest. Skip only when nothing under mobile/android/ changes."
---

# Compose renders the shared state. It decides nothing.

Recorded as ADR: `docs/adr/2026-10-24-kotlin-multiplatform-below-native-mobile-ui.md`.

The screen's state and effects come from the shared ViewModel
(`shared-viewmodel`); navigation belongs to the app (`mobile-navigation`).
This skill is the Compose side of a screen.

## 1. Modules and packages

| Gradle module | Kotlin package | Holds |
|---|---|---|
| `:android:core:ui` | `cz.semprec.app.core.ui` | `AppTheme`, `StatusView` with `Status`, `StatusTestTags`, `CollectEffects`, the `state_*` strings |
| `:android:feature:home`, `:android:feature:settings` | `cz.semprec.app.feature.<name>` | the router contract and its effect mapping, `<Name>TestTags`, `presentation/screen/<dir>/`, `presentation/components/`, the feature's strings |
| `:android:app` | `cz.semprec.app` (`.navigation`, `.components`) | `MainActivity`, `SemprecApplication`, Koin `appModule`, `AppScene`, the type-safe routes (`AppRoutes.kt`), the tab hosts, the bottom bar, `AboutSheet`, `SceneNavigation` |

A feature's project dependencies are `:android:core:ui` and
`:shared:presentation`. It never depends on another feature, on Koin or on a
navigation library; only the app does. Only two of those are checked
mechanically: `ARCH-GRADLE` fails a `project(":…")` edge to another feature,
and `NAV-OWNERSHIP` fails an `androidx.navigation` import or a
`NavController`/`NavHostController` in a feature. No rule checks Koin: the
review does (`mobile/android/review-rules/tasks/architecture.md` item 7), and
so does the checklist below. Why: a feature that knows another feature, the
navigation stack or the dependency container can no longer be composed
differently by the app (`mobile-navigation`).

A library's generated `R` class is not in its Kotlin package: its namespace is
`cz.semprec.app` plus the Gradle path, so code in `cz.semprec.app.feature.home`
imports `cz.semprec.app.android.feature.home.R`. The app's is
`cz.semprec.app.R`.

## 2. XScreen wires, XScreenLayout renders

Each screen directory under `presentation/screen/` holds two files. The
`ORG-SCREEN` rule checks only that a `XScreen.kt` directly in a
`presentation/screen/<folder>/` has its `XScreenLayout.kt` next to it; a screen
anywhere else in `src/main` passes it, and the review reports it
(`mobile/android/review-rules/tasks/architecture.md`):

- `XScreen.kt`: `fun XScreen(viewModel: XViewModel, router: XRouter, modifier: Modifier = Modifier)`.
  It collects `viewModel.state.collectAsStateWithLifecycle()`, maps effects
  with `CollectEffects(viewModel.effects, router::handle)`, and passes the
  state plus one lambda per intent (`{ viewModel.onAction(HomeAction.Retry) }`)
  to the layout. A screen whose effect type is `Nothing` collects no effects
  (`DetailScreen`). Never collect effects any other way: `CollectEffects`
  collects only while STARTED and on `Dispatchers.Main.immediate`, which is
  what delivers every effect emitted on the main thread exactly once
  (`shared-viewmodel` §1); a plain `LaunchedEffect` collection resumes on
  Compose's always-posting dispatcher, and a stop queued before that resume
  loses the effect.
- `XScreenLayout.kt`: a public, stateless composable of state, callbacks and
  `modifier`. It never sees the ViewModel, so its previews need no SDK.

The app creates the ViewModel with `koinViewModel` in its tab host and passes
it in. Do not add an Android ViewModel next to the shared one. Why: a second
ViewModel is a second owner of the screen's decisions and lifetime
(`shared-viewmodel` §2).

A screen without a shared ViewModel has a layout only. `screen/about/` holds
just `AboutScreenLayout`, which the app presents inside `AboutSheet` and to
which it passes `BuildConfig.VERSION_NAME`, `BuildConfig.VERSION_CODE` and
`onDone`.

## 3. States, copy and test tags

- Loading, empty and failure go through `StatusView(Status.Loading)`,
  `Status.Empty(message)` and `Status.Error(message, onRetry)`. A failure's
  message is `stringResource(failureMessage(state.failure))`
  (`feature/home/.../presentation/FailureMessage.kt`): `UNAVAILABLE` gives
  `failure_unavailable`, `INVALID_DATA` gives `failure_invalidData`, and
  `null` gives `failure_unexpected`.
- Every user-visible string is a `stringResource(R.string.<name>)` of the
  module that renders it, defined in its `src/main/res/values/strings.xml`
  (English, the fallback) and `src/main/res/values-cs/strings.xml` (Czech).
  The name is the Apple key with dots replaced by underscores
  (`home.item.title` is `home_item_title`), and arguments are positional
  (`%1$d`, `%1$s`). Load `canonical-keys` before you add one.
- An interactive or asserted node gets `Modifier.testTag(...)` with a constant
  from the module's tag object (`StatusTestTags`, `HomeTestTags`,
  `SettingsTestTags`, `AppTestTags`). The value equals the Apple
  accessibility identifier of the same element (`home.screen`,
  `home.item.<id>`, `about.done`). `AppScene` sets
  `testTagsAsResourceId = true` on its root and `AboutSheet` sets it again,
  because a modal bottom sheet is a window of its own; UIAutomator and
  `bb device-lab describe` then show the tags as resource ids.
- Lists use stable keys: `items(state.items, key = { it.id })`.

Why the tags and keys are mirrored: UI tests on both platforms find the same
element by the same identifier, and the architecture check compares the copy
keys of both platforms (`COPY-PARITY`).

## 4. Previews and Compose rules

- Previews are `private` `@Preview` functions in the layout's file, wrapped in
  `AppTheme { }`, with literal state (`HomeState(HomePhase.EMPTY)`). Cover each
  phase the layout branches on that a reviewer would want to see.
- The `semprec.android.compose` and `semprec.android.application` plugins add
  the preview tooling (`addComposePreviewTooling()` in
  `mobile/build-logic/src/main/kotlin/ComposeConfiguration.kt`), and detekt's
  `UnusedPrivateMember` ignores members annotated `@Preview`
  (`ignoreAnnotated: ['*Preview']`), so a private preview needs no
  suppression.
- `mobile/config/detekt/detekt.yml` lists every rule of the
  `io.nlopez.compose.rules` set (for example `ModifierMissing`,
  `ModifierNotUsedAtRoot`, `PreviewPublic`, `ViewModelForwarding`,
  `ViewModelInjection`). A public composable that emits UI takes
  `modifier: Modifier = Modifier` and applies it to its root.
- Use `remember`, `rememberSaveable` and `derivedStateOf` for a lifetime or
  recomposition need you can name, not by default. Look at recomposition or
  list identity when a problem is demonstrated, not before.

## 5. Build configuration

- Library modules apply `id("semprec.android.compose")` (Compose) or
  `id("semprec.android.library")`; the app applies
  `id("semprec.android.application")`. The plugins read SDK levels and identity
  from `mobile/gradle/project.properties`. Do not set them per module.
- `mobile/android/app/build.gradle.kts` holds what only the app has: the
  `debug` (`applicationIdSuffix = ".debug"`) and `release` (R8 with
  `isMinifyEnabled` and `isShrinkResources`) build types, `BuildConfig`, and
  `lint { checkDependencies = true; warningsAsErrors = true }`. One
  `:android:app:lintDebug` therefore checks every Android module, and a missing
  Czech string or an unused resource fails it.
- `semprec.android.application` also applies Kotlin's serialization plugin
  (`org.jetbrains.kotlin.plugin.serialization`, through
  `mobile/build-logic/build.gradle.kts`), and the app depends on
  `kotlinx-serialization-core`: the type-safe navigation routes in
  `AppRoutes.kt` are `@Serializable` (`mobile-navigation` §2).
- The release build has no keep rules of its own, only
  `proguard-android-optimize.txt`. Code that adds reflection or serialization
  must prove itself in a release APK on a device, not only in debug. The
  type-safe routes add no rule of their own: the `kotlinx-serialization-core`
  jar carries its R8 consumer rules (`META-INF/com.android.tools/r8/`).

## 6. Verify what was rendered

| Command (from `mobile/`) | Proves |
|---|---|
| `./gradlew androidUnitTest` | the JVM tests of every Android module (router mappings, `FailureMessageTest`, `CollectEffectsTest`, `SceneNavigationTest`, `QueuedNavigationTest`) |
| `./gradlew :android:app:lintDebug` | lint over the app and every module it depends on |
| `./gradlew detektAll -PdetektAutoFix=false` | detekt with the formatting and Compose rules |
| `mobile/scripts/verify android` | assemble debug and release, `androidUnitTest`, `lintDebug` |
| `mobile/scripts/verify android --android-serial <serial>` | the same plus `connectedDebugAndroidTest` (`SmokeFlowTest`, `HomeStackTest`, `LaunchIntentTest`) on an emulator you reserved |

The `android` step of `mobile/scripts/verify` does not run detekt; detekt runs
in the `shared` step, so a Kotlin change under `mobile/android/` needs
`mobile/scripts/verify shared android` or the default `all`. When behaviour on
screen changes, run the instrumented test on a reserved emulator, or install
the APK and drive it (`mobile-verify`). A preview that compiles proves only
that it compiles; report what you actually rendered and exercised.

## Before committing, check

- [ ] Each changed screen still has `XScreen.kt` (wiring) and
      `XScreenLayout.kt` (stateless); the layout never sees the ViewModel.
- [ ] No Android ViewModel, Koin call or navigation API was added to a feature
      module.
- [ ] Every new string exists in `values/strings.xml` and
      `values-cs/strings.xml` of the module that renders it, under the
      mirrored key name.
- [ ] Every new interactive or asserted node has a tag from the module's
      `*TestTags` object, equal to the Apple identifier.
- [ ] New layouts have private previews in `AppTheme` with literal state.
- [ ] `androidUnitTest`, `lintDebug` and `detektAll` passed, and the
      instrumented test ran on a reserved emulator when behaviour changed, or
      the report says it did not run.
