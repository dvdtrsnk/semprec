---
status: accepted
date: 2026-11-26
area: [mobile]
supersedes: []
superseded-by: null
---

# The wake guard holds the volume up with undocumented UIKit internals, and the owner accepts the risk

## Context

While a wake mission rings (`2026-11-26-wake-missions-ring-until-a-code-is-scanned`), the person who cannot get up can
still turn the device's volume down and so silence the alarm without scanning anything. The owner wants the volume
driven to its maximum and held there for as long as the guard covers the window.

iOS has no public API that sets the system output volume. The only way an app can move it is the slider inside an
`MPVolumeView`: the view creates a `UISlider` among its subviews, and setting that slider's value moves the device's
volume. The slider is not part of `MPVolumeView`'s documented interface; it is found by looking at the view's subviews.
This is the same technique an earlier version of this feature used, and it is the one thing in the app that depends on
UIKit internals rather than on a documented contract.

## Decision

- **The shared layer decides when.** `WakeGuardState.holdsVolume` of the Kotlin `WakeGuardViewModel` is true for as long
  as a mission rings, in the scanning and in the tapping phase, and false otherwise. Swift does not re-derive it from
  the phase. The one thing Swift adds is the platform fact that its scene is the active one, as it does for the camera
  and the beep: the volume is held only while `holdsVolume` is true and the window's scene phase is active.
- **No Kotlin port.** The recording and alarm adapters implement Kotlin interfaces because Kotlin calls them
  (`2026-11-16-recording-and-playback-use-avfoundation-behind-kotlin-facing-ports`). Nothing in the shared layer calls
  the volume: it publishes a flag and the screen reads it, as it does for the camera and the beep, which are CoreKit
  classes the screen drives. A port would be an interface with no caller in Kotlin, so the adapter is a CoreKit view.
- **The adapter.** `DeviceVolumeHold` in CoreKit is a SwiftUI view with an `isHeld` flag. Its hold lives with the view's
  `.task(id: isHeld)`, so leaving the screen, the scene leaving the active phase or the flag turning false cancels it;
  there is no task of its own. `VolumeHold` raises the volume once when it starts and again whenever the system reports
  that the output volume changed, so it waits on those reports and polls nothing. Only when the system's slider is not
  there yet, because the hidden view is not laid out, it retries eight times at a quarter of a second and then waits for
  the next change.
- **The private part is one file.** `MediaPlayerVolume` implements the small `SystemVolume` protocol (level, raise,
  changes) with `MPVolumeView`, `AVAudioSession.outputVolume` and the slider. It is the only file that imports
  `MediaPlayer`, which is added to `apple.systemModules`, and the only one under `#if os(iOS)`. On macOS the view shows
  nothing and holds nothing: the system volume is the person's own.
- **No new permission or entitlement.** The hold needs no Info.plist key.

## Consequences

- **App Review may reject the app.** The slider is found through undocumented internals; Apple has not said this use is
  acceptable and may refuse a build or an update for it. If a review rejects it, the remedy is to delete
  `MediaPlayerVolume`, `VolumeHold` and the view's use in the guard, which touches nothing else.
- **It may break silently on an iOS update.** If a release changes the volume view's subviews, `raiseToMaximum` finds no
  slider and the hold does nothing, with no error to report and no way for the app to know. The only signal is a person
  finding the alarm quiet.
- **The alarm still rings without it.** The system alarms, the watch alarms, the guard's own beep and the scan or taps
  that end the mission do not depend on the volume hold. A broken hold costs the guarantee that the volume cannot be
  turned down, and nothing more.
- **The owner accepted this risk** on 2026-11-26 when asking for the volume hold, knowing the App Review and iOS update
  consequences above.
- The slider, the audio session and the system's response run only on a device, so no test reaches the private call.
  The on/off contract of `VolumeHold` (raise at start, raise again after each drop, leave a volume at its maximum alone,
  retry a missing slider a bounded number of times, stop on cancellation) and the shared flag
  (`WakeGuardViewModelTest`, the CoreKit mapping and real-ViewModel tests) are tested without one; that the volume really
  stays up is confirmed only by running the app on a device.
- The hold raises the volume the guard's beep and the system's alarms play at; it does not change the silent switch, the
  person's headphones or the volume after the mission ends, which stays at its maximum until the person turns it down.
- Android has no counterpart; it would set the alarm stream volume through its documented audio manager.
