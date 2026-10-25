- A finding needs evidence: the changed line, the caller, consumer or owner you
  read, and the concrete consequence; a name or keyword match alone is not
  evidence. When the task item names a rule ID, start the description with it
  (`NAV-OWNERSHIP: …`). The three mobile platforms (`mobile/`, `mobile/android/`,
  `mobile/apple/`) use the same rule IDs, so one defect class reads the same on
  each of them and a fix can find its parallel copies.
- The app composes the features; a feature depends only on `:android:core:ui`
  and `:shared:presentation`, never on another feature or on the app, and
  `:android:core:ui` depends on no feature. Business outcomes come from the
  shared ViewModels: Android code formats, renders and handles platform UX, and
  does not re-derive validation, ordering or what a failure means.
  (`docs/adr/2026-10-24-kotlin-multiplatform-below-native-mobile-ui.md`)
- A shared screen ViewModel is created only through Koin's `koinViewModel` in
  the app's navigation destinations, so the `ViewModelStore` of its back-stack
  entry retains it and clears it when the entry leaves the stack; `appModule`
  registers it from `HomeSDK`. Its state is collected with
  `collectAsStateWithLifecycle` and its effects with `CollectEffects`, which
  collects only while the screen is STARTED, so an effect raised while the
  screen is stopped waits in the ViewModel's channel, and on
  `Dispatchers.Main.immediate`, so a stop cannot cancel the collector between
  the channel's hand-off and its resume: every effect emitted on the main
  thread is delivered exactly once while the ViewModel lives. A feature module
  neither depends on Koin nor calls it; only the app composes with Koin, and
  no architecture rule checks this.
  (`docs/adr/2026-10-24-shared-screen-viewmodel-lifecycle-and-native-hosting.md`)
- `<X>Screen` wires the ViewModel, collects state and effects and maps effects
  to the feature router; `<X>ScreenLayout` takes immutable state and callbacks
  only, with no ViewModel, Koin or router, and has private previews. That keeps
  every layout renderable in previews and tests without the shared runtime.
- Features declare router interfaces and the app implements them; no
  `NavController` in a feature or a ViewModel. Every router call becomes a
  `SceneNavigation` command that runs once, while the scene is STARTED, and is
  acknowledged right after it ran. Destinations are type-safe `@Serializable`
  routes whose arguments are non-null typed properties, read with `toRoute`;
  a destination whose ViewModel is built from navigation arguments is pushed
  as a new entry, never with `launchSingleTop`, which would keep the previous
  entry's `ViewModelStore` and so its ViewModel.
  (`docs/adr/2026-10-24-app-owned-mobile-navigation-through-feature-routers.md`)
- Every user-visible string, content descriptions included, comes from the
  rendering module's `res/values/strings.xml` with a Czech translation in
  `res/values-cs/strings.xml`, named after the Apple key with `.` replaced by
  `_`; a failure maps `FailureKind` to its `failure_*` string and an unexpected
  failure (`null`) to `failure_unexpected`.
  (`docs/adr/2026-10-24-mobile-copy-localized-natively-from-typed-state.md`)
- Test tags come from the module's `*TestTags` object, with the same value the
  Apple app gives the same element, so one UI test plan finds the same element
  on both apps.
- Every backend call goes through the shared data layer; no HTTP client in this
  app. (`docs/adr/2026-10-24-mobile-backend-calls-through-shared-data-layer.md`)
- No `!!`, no unchecked `as`, no `@Suppress` without a one-line reason, and a
  `when` over a sealed or enum type lists every case instead of an `else`, so a
  new case fails the build where it must be handled. Data that did not come
  from this code's own types — a navigation argument, a saved-state value — is
  checked where it is read (rule 6 in `.bb/AGENTS.md`), in tests as in the app:
  test code is copied into production code.
- Secrets, tokens, signing keys and credentials never appear in a committed
  file, a log call or source; the release signing configuration is never
  committed. The manifest keeps `android:allowBackup="false"` and data
  extraction rules that exclude everything, and exports only the launcher
  activity.
- No new abstraction, helper, or config flag beyond what the current issue's
  Task asks for — flag speculative generality the same way the project's
  own contribution guidance treats it: a smell, not a virtue.
  (`docs/adr/2026-09-10-no-speculative-generality-beyond-issue-scope.md`)
- A PR that introduces a genuinely new architectural pattern not covered by an
  existing rule here or by an ADR must add one under `docs/adr/` (see
  `docs/adr/README.md` for the format) — a new cross-cutting pattern with no ADR
  and no rule covering it is a medium-severity finding.
- Not findings on this platform: a router method a `Screen` calls directly for
  navigation the shared ViewModel has no action for (`HomeRouter.closeDetail`);
  back and recreation behavior that looks different from the Apple app while
  the outcome is the same; a plain `launch` with correct error handling; Koin
  registration syntax; and the style output of detekt and lint — formatting,
  whitespace, import order and naming — which the author's own run settles.
  That exclusion covers style only, never a defect a task item rates: a `!!` or
  unchecked cast (detekt `UnsafeCallOnNullableType`, `UnsafeCast`), a string
  without its Czech translation (lint `MissingTranslation`) or an unused import
  or resource (`NoUnusedImports`, `UnusedResources`) is still reported under
  its task item, naming the tool's rule. CI runs these tools on changes under `mobile/`; a tool also
  reporting a rated defect does not make it a non-finding.
