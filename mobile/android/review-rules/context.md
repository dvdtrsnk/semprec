This is the `mobile/android/` platform of the Semprec monorepo (the repository
root, `backend/`, `web/`, `mobile/` and `mobile/apple/` are separate platforms
with their own review-rules and are reviewed independently). `mobile/android/`
is the native Android app: Kotlin, Jetpack Compose with Material 3, Koin and
Navigation Compose, built by the Gradle root in `mobile/` with the convention
plugins of `mobile/build-logic/` (both reviewed by the `mobile/` platform).
`scope.md` includes every file under `mobile/android/` (`**`). Screen logic and
business decisions come from the shared Kotlin Multiplatform modules in
`mobile/shared/`, also reviewed by the `mobile/` platform; this app renders
their state, maps their effects to navigation, owns the copy and handles the
Android lifecycle. The Apple app in `mobile/apple/` renders the same shared
ViewModels, so the two apps are expected to behave alike
(`tasks/parity.md`). The modules:

- `:android:app` (`app/`, package `cz.semprec.app`) — `SemprecApplication`
  starts Koin with `appModule` (`single { HomeSDK() }` and one `viewModel { … }`
  per shared screen ViewModel); `MainActivity` shows `AppScene`; `AppScene` and
  `AppSceneState` own the bottom bar (`AppTab`), one `NavHostController` per
  tab (`HomeTabHost`, `SettingsTabHost`) over the type-safe routes of
  `AppRoutes.kt` (`HomeRoute`, `DetailRoute(itemId)`, `SettingsRoute`, which
  need the kotlinx-serialization plugin the `semprec.android.application`
  convention plugin applies) and the About sheet (`components/AboutSheet.kt`);
  `navigation/SceneNavigation.kt` implements the feature routers. `app/build.gradle.kts` defines the debug and release build
  types (release minified with R8, unsigned in the repository) and runs lint
  over every module with `checkDependencies` and `warningsAsErrors`.
- `:android:feature:home` and `:android:feature:settings` — per screen, under
  `presentation/screen/<name>/`, a `<X>Screen` that takes the shared ViewModel
  and the feature router, collects state with `collectAsStateWithLifecycle`
  and effects with `CollectEffects`, and a stateless `<X>ScreenLayout` with
  private previews; the router interface (`HomeRouter`, `SettingsRouter`) with
  its effect mapping (`handle`); the module's test tags and strings. About has
  no shared ViewModel, so `screen/about/` holds only `AboutScreenLayout`, which
  the app presents with the version from `BuildConfig`. A feature depends only
  on `:android:core:ui` and `:shared:presentation`.
- `:android:core:ui` — `AppTheme`, `StatusView` with `Status` (loading, empty,
  error with retry), `CollectEffects` and `StatusTestTags`. It depends on no
  other project. `CollectEffects` collects a shared ViewModel's effects only
  while the screen is STARTED and on `Dispatchers.Main.immediate`, so every
  effect emitted on the main thread reaches the screen exactly once while the
  ViewModel lives; the shared channel alone guarantees only at most once,
  because a collector cancelled between hand-off and resume drops the effect
  (`CollectEffectsTest`).

Every navigation request goes through `SceneNavigation`, an activity-scoped
`ViewModel` backed by a `SavedStateHandle` that `MainActivity` creates without
the launch intent's extras, and whose saved values `SceneNavigation` reads
untyped and narrows. `MainActivity` is exported and declares no deep link, so
before anything reads it, at the top of `onCreate`, it also replaces its
intent with `withoutLaunchContent()` (action, categories, component, package
and identifier only), and `onNewIntent` hands on only such a copy: otherwise
each tab's `NavHostController` would follow Navigation's deep-link extras of
the intent when its `NavHost` sets its graph. A router call queues a
`NavigationCommand` with a sequence number, `AppScene` collects `commands` only
while STARTED, runs one command at a time through `AppSceneState.execute` and
acknowledges it right after, so each command runs exactly once across a
stopped scene, recreation and process death. `SceneNavigation` is the only
Android `ViewModel` that is not a shared screen ViewModel. Every user-visible
string is in `res/values/strings.xml` (English, the fallback) and
`res/values-cs/strings.xml` (Czech) of the module that renders it, named after
the Apple String Catalog key with `.` replaced by `_`; `detail_back` has no
Apple counterpart (Apple uses the system back button) and `app_name` is the
untranslated launcher label. Asserted and interactive nodes carry test tags
from the module's `*TestTags` object, whose values equal the Apple
accessibility identifiers, and `AppScene` and `AboutSheet` (a window of its
own) expose them as resource ids (`testTagsAsResourceId`).

The decisions this platform is held to are
`docs/adr/2026-10-24-kotlin-multiplatform-below-native-mobile-ui.md`,
`docs/adr/2026-10-24-shared-screen-viewmodel-lifecycle-and-native-hosting.md`,
`docs/adr/2026-10-24-app-owned-mobile-navigation-through-feature-routers.md`,
`docs/adr/2026-10-24-mobile-copy-localized-natively-from-typed-state.md`,
`docs/adr/2026-10-24-mobile-backend-calls-through-shared-data-layer.md` and
`docs/adr/2026-10-24-monorepo-holds-backend-web-and-mobile.md`, next to the
repository-wide `docs/adr/2026-09-10-no-speculative-generality-beyond-issue-scope.md`.

`mobile/scripts/verify` runs the mechanical checks (`mobile/scripts/verify
[all|architecture|shared|android|apple]`). Its `architecture` step runs
`node mobile/scripts/architecture.mjs` with the policy in
`mobile/scripts/architecture-policy.json`; for this app it enforces the module
dependencies (`ARCH-GRADLE`), navigation libraries and controllers only in
`:android:app` and in no ViewModel (`NAV-OWNERSHIP`), an Android `*Screen` that
takes every shared screen ViewModel (`VM-BRIDGE`), a `<X>ScreenLayout.kt` next
to every `<X>Screen.kt` that sits directly in a `presentation/screen/<folder>/`
(`ORG-SCREEN`), and the string names of every module matching the policy's
copy keys, each with a non-empty English and Czech value, in `src/main/res` and
in no other non-test source set's `res` (`COPY-PARITY`). `ORG-SCREEN` looks only
into the folders directly below a `presentation/screen/` directory: a
`<X>Screen.kt` anywhere else in `src/main`, a screen and its layout in one
file, or several unrelated public types in one file pass it, and the review
checks them (`tasks/architecture.md`). No rule checks that features stay free
of Koin either; the review does (`tasks/architecture.md`). Its
`android` step builds the debug and release APKs and runs the unit tests and
lint; detekt with the formatting and Compose rules runs in the `shared` step.
The instrumented tests run only on a running device the caller passes in
(`--android-serial`). No CI job runs `mobile/scripts/verify` —
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
