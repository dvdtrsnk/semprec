---
status: accepted
date: 2026-11-24
area: [mobile]
supersedes: []
superseded-by: null
---

# Wake-up alarms ring until a code is scanned

## Context

[[2026-11-24-apple-app-rings-system-alarms-through-alarmkit]] lets the Apple app schedule AlarmKit alarms from a debug
tool. The person wants an alarm that makes sure they get up: it rings until they scan a barcode or QR code they chose
(the toothpaste in the bathroom), even if they stop the system alert or open the app, and after ten minutes of ringing
they may tap the screen 200 times instead. They must not be able to turn it down or around.

AlarmKit always shows a Stop button on the system alert, and a third-party app cannot remove it or make it
conditional; a stop intent cannot keep the alarm ringing, and the app gets no guaranteed run time after Stop. Developers
of AlarmKit wake-up apps answer this with a chain of alarms scheduled in advance (for example the open-source
`better-alarm-ios`, "Mission Guard"): Stop silences one alert, the next one rings a minute later, and only finishing
the mission cancels the rest. iOS lets an app set the device volume only through the system volume slider
(`MPVolumeView`), which alarm apps host out of sight. The architecture policy did not list `AppIntents`, `MediaPlayer`
or `VideoToolbox`, and the Apple app imports no UIKit.

## Decision

- A wake-up mission (`WakeMission`) is an alarm the person sets plus the codes that end it. When it is armed, the
  `WakeGuard` of the app schedules watch alarms after its next ring: every minute for 30 minutes, then every five
  minutes up to two hours. They are on the system's timers before the person sleeps. Ending the mission stops the ones
  ringing and cancels the waiting ones; nothing else does. If the system refuses more alarms, the accepted ones still
  guard the ring. A daily mission keeps its repeating alarm and arms the next day's watch alarms when it ends; a single
  ring's mission is removed.
- Ringing is decided by the clock, not by AlarmKit's state: from its guarded ring until it ends, a mission rings,
  whatever happened to the system alert. The missions are kept as JSON in the app's user defaults, so a relaunch
  finds a ringing mission ringing.
- While a mission rings, every window of the app is covered by the guard (`WakeGuardHost` at the app's root): the
  camera waits for a code, nothing on it closes it, and the sheets open over the tabs are dismissed through the root
  navigator. After `WakeMission.tapFallbackDelay` (10 minutes) it offers the tap fallback; `WakeMission.requiredTaps`
  (200) taps end the mission. A code matches when it equals one of the mission's codes after trimming whitespace.
- The guard plays its own beep through `AVAudioEngine` in the playback category, which the silent switch does not mute
  and which keeps playing in the background (the app already has the `audio` background mode). `VolumeEnforcer` hosts
  the system volume slider out of sight and moves it to the top whenever the output volume drops. It reaches the slider
  by key-value coding, so the app still imports no UIKit; `MediaPlayer` is an allowed system module for it.
- The camera is read through AVFoundation (`AVCaptureMetadataOutput` for the codes) and its frames are drawn by
  SwiftUI after `VideoToolbox` turns them into images, so no UIKit preview layer is needed. `VideoToolbox` is an
  allowed system module.
- A wake-up alarm's alert has a second button that runs `OpenWakeGuardIntent`, a `LiveActivityIntent` that opens the
  app on the guard. `AppIntents` is an allowed system module.
- The alarm UI is drawn by another process, which does not look strings up in the app's catalog, so every alert text
  is resolved in the app and handed over as finished text.
- The guard, its store and its screens are native app code without a shared ViewModel, under the same reasoning as the
  debug tool of [[2026-11-24-apple-app-rings-system-alarms-through-alarmkit]]: they drive platform APIs (AlarmKit,
  the camera, the audio session) and hold only this device's alarms, not the person's data. Missions are created from
  the debug tool for now.

## Consequences

- The person can still defeat the guard from outside the app: refuse alarms for Semprec in Settings, delete the app,
  or let the two hours of watch alarms run out without opening the app. A daily mission whose ring was never ended
  does not arm the next day's watch alarms until the app runs again; its own alarm still rings.
- Holding the volume up uses the system slider in a way it was not designed for; Apple may change it, and App Review
  may question it. It only runs while the guard is on screen.
- Watch alarms count against the system's limit of alarms per app; how many a device accepts is not documented, and a
  refusal is shown on the debug screen.
- Wiring the sleep plans' alarms to missions, and any Android counterpart, need decisions of their own.
