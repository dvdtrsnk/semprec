- A finding needs evidence: the changed line, the caller, consumer or owner you
  read, and the concrete consequence; a name or keyword match alone is not
  evidence. When the task item names a rule ID, start the description with it
  (`SHARED-VM: …`). The three mobile platforms (`mobile/`, `mobile/android/`,
  `mobile/apple/`) use the same rule IDs, so one defect class reads the same on
  each of them and a fix can find its parallel copies.
- Kotlin Multiplatform owns everything from the screen ViewModel down. `domain`
  depends on `core`, `data` on `domain`, `presentation` on `core` and `domain`
  but never on `data`, and only the umbrella composes all of them. Contracts
  belong in core or domain, implementations in data, composition and native
  export in the umbrella; a change that needs a new edge moves a contract down
  to an allowed module instead. `commonMain` uses only APIs every configured
  target has — a multiplatform `androidx.*` artifact such as
  `lifecycle-viewmodel` is valid there.
  (`docs/adr/2026-10-24-kotlin-multiplatform-below-native-mobile-ui.md`)
- The exported framework is the umbrella's API: only `presentation` and `core`
  are exported, `HomeSDK` returns a new ViewModel on every call, and ViewModel
  constructors stay `internal` so that only the SDK creates them. Domain, data
  and factory types never become reachable from Swift. The CoreKit bridges read
  the exported contract — nullability, collections, enums and sealed types,
  suspend functions and flows — so it changes together with them.
  (`docs/adr/2026-10-24-kotlin-multiplatform-below-native-mobile-ui.md`)
- A screen ViewModel extends `ScreenViewModel`: immutable state, sealed
  interfaces for actions and effects (`Nothing` as the effect type of a screen
  without effects, like `DetailViewModel`), work only in `viewModelScope`, and
  nothing after `close()`. Expected failures are typed values in state
  (`RepositoryResult.Failure`, `FailureKind`); an unexpected failure ends in the
  error phase with no kind; `CancellationException` is rethrown, and closing or
  superseding a load never produces an error state.
  (`docs/adr/2026-10-24-shared-screen-viewmodel-lifecycle-and-native-hosting.md`)
- Shared state carries typed values — phases, `FailureKind`, ids, ordinals —
  never text a user reads; each app localizes them through its own resources.
  A user-visible string in shared code bypasses the English and Czech resources
  of both apps. (`docs/adr/2026-10-24-mobile-copy-localized-natively-from-typed-state.md`)
- A shared ViewModel never navigates: it emits an effect, and the native app
  maps the effect to a feature router. Shared code holds no navigation API and
  no router type.
  (`docs/adr/2026-10-24-app-owned-mobile-navigation-through-feature-routers.md`)
- Every backend call of a mobile app goes through the shared data layer: a
  network client belongs in `:shared:data` behind a domain port, never in
  presentation, domain or the umbrella. None exists yet.
  (`docs/adr/2026-10-24-mobile-backend-calls-through-shared-data-layer.md`)
- No `!!`, no unchecked `as`, no `@Suppress` without a one-line reason, and a
  `when` over a sealed or enum type lists every case instead of an `else`.
  Shared code runs in both apps, so a crash, or a new case silently taking the
  `else` branch, reaches both at once. Data that did not come from this code's
  own types is checked where it enters (rule 6 in `.bb/AGENTS.md`), in
  `commonTest` as in `commonMain`: test code is copied into production code.
- Every dependency and plugin version is pinned in `gradle/libs.versions.toml`,
  and every identity, version and SDK value is read from
  `gradle/project.properties` (build scripts call `configurationValue`), whose
  Apple values `apple/Tuist/ProjectDescriptionHelpers/ProjectConfiguration.swift`
  repeats. A version or identity typed into one build script drifts from the
  other modules and from the Apple project.
- Secrets, tokens, signing keys and credentials never appear in a committed
  file, a log call or source; `.gitignore` keeps signing material and
  `local.properties` out of the repository.
- No new abstraction, helper, or config flag beyond what the current issue's
  Task asks for — flag speculative generality the same way the project's
  own contribution guidance treats it: a smell, not a virtue.
  (`docs/adr/2026-09-10-no-speculative-generality-beyond-issue-scope.md`)
- A PR that introduces a genuinely new architectural pattern not covered by an
  existing rule here or by an ADR must add one under `docs/adr/` (see
  `docs/adr/README.md` for the format) — a new cross-cutting pattern with no ADR
  and no rule covering it is a medium-severity finding.
- Not findings on this platform: a use case that only forwards, whether
  present or absent; naming preferences; how an app renders a state, which each
  app's own platform reviews; and the style output of detekt — formatting,
  whitespace, import order and naming — which the author's own run settles.
  That exclusion covers style only, never a defect a task item rates: a `!!` or
  unchecked cast (`UnsafeCallOnNullableType`, `UnsafeCast`), a swallowed
  exception (`SwallowedException`) or an unused import (`NoUnusedImports`) is
  still reported under its task item, naming the detekt rule. No CI job runs
  detekt or `mobile/scripts/verify`, so a tool also reporting a rated defect
  does not make it a non-finding.
