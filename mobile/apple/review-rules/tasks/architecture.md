Check for architecture and ownership violations:

1. A view, view model, CoreKit bridge or app code talking to the backend
   directly (`URLSession`, another HTTP client) instead of through the shared
   Kotlin data layer — high severity.
2. Platform-specific branching (`#if os(iOS)` / `#if os(macOS)`) used where a
   shared implementation would work identically on both — medium severity
   (flag it as unnecessary duplication).
3. New abstraction, config flag, or generalization not required by the
   linked issue's Task — medium severity (flag it as scope creep, not a
   style nitpick).
4. A module/feature reaching into another module's internals instead of its
   declared public interface — high severity.
5. A `Project.swift` dependency or an import that makes a feature depend on
   another feature, the app or `SharedSDK`, or a core module depend on a
   feature — `ARCH-DEPENDENCY`, high.
6. A project-owned target that does not use `SemprecProject.destinations` and
   `SemprecProject.deploymentTargets`, a minimum version or architecture set
   outside `Tuist/ProjectDescriptionHelpers/`, or a package linked to a target
   that does not use it — `ARCH-DEPENDENCY`, medium: every target must build
   for the same destinations, minimums and arm64 slices as the Kotlin
   framework. The one exception is the XCUITest bundle `SemprecUITests`,
   which builds for `[.iPhone, .iPad]` with `.iOS(ProjectConfiguration.iosMinimum)`
   because macOS XCUITest needs the Accessibility permission; another target
   with its own destinations, or that bundle with other destinations or a
   literal minimum, is still this item.
7. A feature exposing more than its `<Feature>ScreenFactory` and routing
   protocol — a screen, a screen ViewModel or a helper made `public` — without
   a consumer outside the module — `ARCH-DEPENDENCY`, medium: the app would
   then be able to create a screen around the `@StateObject` ownership the
   factory guarantees.
8. Swift code that re-derives a decision the shared ViewModel or domain already
   makes or should make — validation, ordering, which phase shows what, what a
   failure means — so the two apps can drift — `DOMAIN-SOURCE`, high when it
   already differs from the shared result, otherwise medium.
9. A genuinely new architectural pattern (not covered by an existing rule or an
   ADR under `docs/adr/`) introduced with no ADR added for it — medium
   severity, flag it as a missing decision record, not a style nitpick. See
   `docs/adr/README.md` for when an ADR is warranted and its format.
10. A screen's view or feature ViewModel outside its feature's
    `Sources/Layers/PresentationLayer/Screens/<X>Screen/` folder (for example
    directly in `Sources/`), a `<X>ViewModel.swift` without its
    `<X>Screen.swift` next to it, or several unrelated primary types in one
    file — `ORG-SCREEN`, medium: the next screen copies the layout it finds,
    and the `ORG-SCREEN` check looks only into the folders directly below a
    `Screens/` directory (`context.md`), so a screen anywhere else passes it.
    A helper only one feature uses belongs in its `Sources/Extensions/`.
11. `// MARK:` sections out of the order the existing files use (a view:
    `Dependencies`, `Init`, `Body`, `Subviews`, `Preview`; a ViewModel:
    `Dependencies`, `Published Properties`, `Init`, `Methods`, `Private`), or a
    production type that implements one of the app's own protocols
    (`ScreenModel`, `ScreenModelFactory`, `StackNavigating`, a feature's
    `*Routing`) on its declaration instead of in an extension under
    `// MARK: - Protocol conformance`, as the CoreKit bridges,
    `SharedScreenModelFactory`, `NavigatorStackAdapter` and the app routers do —
    low: SwiftLint's `marked_extension` checks only that an extension has a
    `// MARK:` before it, not the order. Not findings, wherever they sit:
    conformances to SwiftUI, Foundation, standard-library and third-party
    protocols (`View`, `App`, `ObservableObject`, `ButtonStyle`, `Equatable`,
    `Hashable`, `Sendable`, `Identifiable` and FactoryKit's `ManagedContainer` on
    the declaration; NavigatorUI's `NavigationProvidedDestination` in a marked
    extension of `AppDestination`), and the preview and test doubles
    (`PreviewHomeRouter`, `PreviewSettingsRouter` and `ScriptedScreenModel` on
    the declaration; the test spies `RouterSpy` and `StackSpy` in a
    `// MARK: - Protocol conformance` extension).

Not findings: a consistent older layout in a module the diff does not
restructure; a one-line private helper next to its only caller.
