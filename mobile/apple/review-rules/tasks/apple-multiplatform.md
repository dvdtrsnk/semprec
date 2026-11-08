Check that the change builds and behaves correctly on both Apple platforms:
every target builds natively for iOS, iPadOS and macOS (not Mac Catalyst) from
the same sources, the iOS-only XCUITest bundle `SemprecUITests` aside, and no
CI job builds either of them. A platform conditional
used where shared code would do is item 2 of `tasks/architecture.md`, not a
finding of this task.

1. An API that exists on only one of iOS and macOS — a UIKit or AppKit type,
   an iOS-only modifier such as `navigationBarTitleDisplayMode`, a
   platform-only `ToolbarItemPlacement` — used outside a `#if os(…)` branch or
   an availability check, so the target no longer compiles for the other
   platform — high. The pattern for a genuine difference is a small shared
   helper with the conditional inside it, as
   `Modules/Core/DesignSystem/Sources/View+InlineNavigationTitle.swift` and
   `View+ListRowButton.swift` do.
2. A platform conditional whose branches differ in behavior rather than
   presentation — a destination, an action or a piece of state that exists on
   one platform only — without the linked issue's Task calling for it — high.
3. A target or setting that stops building the app natively for one of the
   platforms: a destination dropped from `SemprecProject.destinations`, Mac
   Catalyst enabled, a deployment target or `ARCHS` value set apart from
   `Tuist/ProjectDescriptionHelpers/` (where `ProjectConfiguration` holds the
   minimums and `architectures`, which `SemprecProject` and
   `Tuist/Package.swift` read) — high. The iOS-only XCUITest bundle
   `SemprecUITests` builds no app and is not this item
   (`tasks/architecture.md` item 6).
4. A setting, Info.plist key or entitlement meant for one platform that the
   change applies to the other: the macOS entitlements file no longer limited
   to `CODE_SIGN_ENTITLEMENTS[sdk=macosx*]`, an iOS-only key whose value
   changes macOS behavior, or the runpath or embed location of
   `SharedSDK.framework` assumed to be the iOS one (`Frameworks/`, while a
   macOS bundle uses `Contents/Frameworks/`) — medium.
5. State that macOS shares between windows although each window must have its
   own — a `static`, a singleton, or an object created outside the scene's
   `AppComposition` — medium; high when one window's screens or navigation
   reach another window. Each `WindowGroup` window builds its own `AppScene`
   with its own composition.
6. UIKit or AppKit imported into `DesignSystem` or a feature where a SwiftUI API
   exists for the same purpose — medium: those modules are shared by both
   platforms, and today they build their UI with SwiftUI alone.
7. A `Button` that is a whole `List` row without `.listRowButton()` — low: on
   macOS it stays a small bordered push button that reacts only on its
   capsule, while the same row reacts across its width on iOS and Android.
