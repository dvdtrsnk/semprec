---
status: accepted
date: 2026-11-27
area: [mobile]
supersedes: []
superseded-by: null
---

# Semp docks in the tab bar on iOS and floats in a window over every presentation elsewhere

## Context

The Semp bubble floated over every screen of the iOS app. A tap opened the chat. Dragging it moved it to an edge.
Dragging it onto an object and holding there gave the object to Semp. A sheet covered the scene's bubble, so each sheet
destination of the app's navigation brought its own bubble with its own drop-target registry. Sheets, covers and
popovers that feature modules present themselves had no bubble at all.

The owner wants Semp in the Liquid Glass tab bar instead: the tabs on the leading side and Semp's own round button apart
from them at the trailing end, the layout Apple's apps use for search. Wherever the tab bar is not visible, because it
is hidden or covered, whatever the navigation that did it, Semp floats as the bubble did. In both places it keeps the
drag onto an object. Docked, a bubble let go springs back into the tab bar.

What the SDK offers (Xcode 27.2, iOS 27 SDK):

- `Tab(role: .prominent)` (iOS 27) is drawn as its own round button at the trailing end of an iPhone's tab bar. On
  iOS 27 a `.search` tab stays inside the bar unless it is the prominent one.
- A tab is drawn by UIKit. SwiftUI attaches no gesture to it, gives no frame for it, and cannot make it the source of a
  zoom transition.
- SwiftUI says neither whether the tab bar is hidden nor whether a presentation covers it. UIKit does not announce
  presentations either.
- SwiftUI on iOS shows a view over a presentation only from inside that presentation, and has no window of its own.

[[2026-10-24-kotlin-multiplatform-below-native-mobile-ui]] set the Apple deployment targets to iOS 26.0 and macOS
26.0, and [[2026-11-26-sleep-alarms-ring-on-the-device-through-alarmkit]] relied on that iOS minimum. This ADR
changes only the iOS minimum; both decisions otherwise stand, and AlarmKit (iOS 26) needs no availability check at 27.0
either.

## Decision

- **The minimum is iOS 27.0** (`ProjectConfiguration.iosMinimum`, `mobile/gradle/project.properties`), so the button is
  `TabRole.prominent` with no branch for iOS 26. This narrows [[2026-10-24-kotlin-multiplatform-below-native-mobile-ui]]:
  its "iOS 26.0" no longer holds, and macOS stays 26.0. The `mobile-apple` CI job runs on the `xcode-27` runner image,
  because the `macos-26` image's default Xcode has no iOS 27 SDK. The iPhone app is portrait only, so the button's place changes only
  with the window's size.
- **The tab is a button, not a destination.** `AppScene` adds a fourth `Tab("tab.semp", role: .prominent)` with empty
  content. The tab view selects through `SceneTab.selection`: selecting Semp opens the chat and keeps the selected tab.
  The tab is hidden where the window is not compact (an iPad's sidebar or top bar) and on macOS. There the bubble only
  floats.
- **The system draws the button, and the bubble docks over it.** The bubble is docked while Semp's button is shown and
  is what a touch at its middle reaches. Docked, the bubble takes the button's frame, draws only its badge and
  attachment count (which the button lacks), and takes the button's touches. A tap opens the chat. A drag lifts a glass
  copy that follows the finger, and the copy springs back into the button when let go. In every other case the bubble
  floats as before, and it is hidden while an alert is shown. `SempDock.state(for:)` decides this from a
  `SempDockReading`, as a pure function.
- **The tab bar is read ten times a second.** `SempDockProbe` (iOS) sits behind the scene's content. It finds the
  window's `UITabBarController`. Ten times a second, through a `CADisplayLink` that runs only while it is in the window,
  it reads two things. The first is the button's frame: the square subview of `tabBar` at its trailing end, which is
  the button the system draws for the prominent tab. The second is whether `window.hitTest` at the button's middle lands
  in the tab bar. It reads polled values because no event exists for a sheet, a cover, a popover or a panel covering the
  bar. The hit test answers every one of them alike, as well as a tab bar hidden by a push or by `tabBarHidden`.
- **The bubble lives in a window over every presentation.** `SempLayerWindowHost` opens a `SempLayerWindow` in the
  scene's window scene, one level above the scene's window. Its root hosts `SempLayer`, which shows the bubble and
  presents the chat. The window takes a touch only inside the bubble's frame while the bubble can be touched, or while
  the chat is open (`SempLayerHitRegion`). Every other touch goes through to the scene. The window becomes key while the
  chat is open so that the chat's text field gets the keyboard, and gives the key window back when the chat closes. The
  per-sheet bubbles are no longer used on iOS.
- **The wake guard still covers everything.** The layer's window is above the scene's window, and so above the wake
  guard, which is an overlay in the scene's window
  (`2026-11-26-wake-missions-ring-until-a-code-is-scanned`). `WakeGuardHost` sets `isWindowGuarded` in the scene's
  environment. While it is true, the layer hides the bubble and closes the chat.
- **One registry, layered by presentation.** A drop target registers in the scene's `DropTargetRegistry` with its
  `PresentationLayer`. On iOS that is the root controller of the presentation that hosts it, read in DesignSystem through
  a zero-size `UIView` behind the target. The probe sets the registry's `topLayer` to the presentation that
  `window.hitTest` finds at a point. Only targets on that presentation count, so an object under a sheet cannot be given
  to Semp through the sheet. macOS keeps the scene bubble, the per-sheet bubbles and their registries, and its targets
  have no layer.

## Consequences

- iOS 26 devices can no longer install the app.
- The button's frame comes from the tab bar's subviews. If an iOS release stops drawing the prominent tab as a square
  subview at the trailing end, the probe finds no frame and the bubble floats everywhere. Nothing breaks, but the bubble
  no longer docks. The structure was checked on the iOS 27.0 simulator.
- The probe polls at ten frames a second while the scene is on screen: one hit test and a few property reads per
  frame. A cover or a hidden tab bar is noticed within a tenth of a second, and the bubble's move between the button and
  its floating place is animated.
- The chat now opens from the layer's window on iOS, over whatever the scene presents. The bubble's zoom transition
  starts from the docked button's frame, or from the floating bubble.
- The docked bubble takes the button's touches, so the system's press effect on the button does not show. VoiceOver
  and the keyboard still reach the system tab, and its selection opens the chat.
- The new UIKit is in four small files, each under `#if os(iOS)` and reached through `import SwiftUI`:
  `PresentationLayer.swift` (DesignSystem), and `SempDockProbe.swift`, `SempLayerWindow.swift` and `SempLayer.swift`
  (the app). `mobile/docs/architecture.md` lists them.
