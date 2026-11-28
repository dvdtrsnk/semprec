Check that the change builds and behaves correctly on both Apple platforms:
every target builds natively for iOS, iPadOS and macOS (not Mac Catalyst) from
the same sources, the iOS-only XCUITest bundle `AlldotsUITests` aside, and no
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
   platforms: a destination dropped from `AlldotsProject.destinations`, Mac
   Catalyst enabled, a deployment target or `ARCHS` value set apart from
   `Tuist/ProjectDescriptionHelpers/` (where `ProjectConfiguration` holds the
   minimums and `architectures`, which `AlldotsProject` and
   `Tuist/Package.swift` read) — high. The iOS-only XCUITest bundle
   `AlldotsUITests` builds no app and is not this item
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
6. UIKit or AppKit used in `DesignSystem` or a feature where a SwiftUI API
   exists for the same purpose — medium: those modules are shared by both
   platforms and build their UI with SwiftUI. Where SwiftUI has no API for the
   behavior, a UIKit type is allowed in one small file of its own, wrapped in
   `#if os(iOS)` with the macOS path in SwiftUI, reached through `import
   SwiftUI` (never `import UIKit`), and with its doc comment naming what SwiftUI
   lacks; `mobile/docs/architecture.md` lists every such file. Today they are
   the calendar's `CalendarDragSource.swift` (a drag whose preview changes while
   it is under way, which `draggable` cannot), `CalendarPinchSource.swift`
   (a gesture that begins only with two touches, which no SwiftUI gesture
   waits for), DesignSystem's `PresentationLayer.swift` (which presentation
   a drop target is on and which one is on top at a point, which SwiftUI does
   not say) and DesignSystem's `DocumentScanner.swift` (the system document
   scanner, a view controller SwiftUI has no view for). Any other UIKit use, or one of these files grown beyond what its
   comment names, is this finding.
7. A `Button` that is a whole `List` row without `.listRowButton()` — low: on
   macOS it stays a small bordered push button that reacts only on its
   capsule, while the same row reacts across its width on iOS and Android.
