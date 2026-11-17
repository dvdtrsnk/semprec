Check for architecture and ownership violations in the Android modules:

1. A `build.gradle.kts` dependency or a production import that makes a feature
   depend on another feature or on the app, or `:android:core:ui` depend on a
   feature — `ARCH-DEPENDENCY`, high. Moving a contract down to an allowed
   module is the fix, not a finding.
2. Android code that re-derives a decision the shared ViewModel or domain
   already makes or should make — validation, ordering, which phase shows
   what, what a failure means — so the two apps can drift — `DOMAIN-SOURCE`,
   high when it already differs from the shared result, otherwise medium.
3. A package that does not match its directory, or one package declared in two
   modules — medium: each module owns its package (`cz.semprec.app`,
   `cz.semprec.app.core.ui`, `cz.semprec.app.feature.home`,
   `cz.semprec.app.feature.settings`), so a type is found by its package, and
   detekt does not check this (`InvalidPackageDeclaration` is off in
   `mobile/config/detekt/detekt.yml`).
4. New abstraction, config flag, or generalization not required by the
   linked issue's Task — medium severity (flag it as scope creep, not a
   style nitpick).
5. A module reaching into another module's internals instead of its declared
   public interface — high severity.
6. A genuinely new architectural pattern (not covered by an existing rule or an
   ADR under `docs/adr/`) introduced with no ADR added for it — medium
   severity, flag it as a missing decision record, not a style nitpick. See
   `docs/adr/README.md` for when an ADR is warranted and its format.
7. A feature module that depends on Koin (a `libs.koin.*` dependency in its
   `build.gradle.kts`) or calls it (`koinViewModel`, `koinInject`, `get()` of a
   Koin scope) — `ARCH-DEPENDENCY`, medium: only the app composes, and no
   architecture rule checks Koin, so the review is the only check.
8. A `<X>Screen` or `<X>ScreenLayout` outside its feature's
   `presentation/screen/<name>/` folder, a screen and its layout in one file,
   or several unrelated public types or composables in one file —
   `ORG-SCREEN`, medium: the next screen copies the layout it finds, and the
   `ORG-SCREEN` check looks only into the folders directly below a
   `presentation/screen/` directory (`context.md`), so a `<X>Screen.kt`
   anywhere else in `src/main` passes it. A screen without a shared ViewModel
   has only its layout (`screen/about/AboutScreenLayout.kt`).

Not findings: formatting or accessibility logic on the platform; platform-only
capabilities (permissions, intents, system services); constructor injection
next to Koin; a consistent older layout in a module the diff does not
restructure; a private helper next to its only caller.
