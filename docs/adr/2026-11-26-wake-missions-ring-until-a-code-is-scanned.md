---
status: accepted
date: 2026-11-26
area: [mobile]
supersedes: []
superseded-by: null
---

# Wake missions ring until a code is scanned, decided in Kotlin and guarded in each window

## Context

A person who cannot get up can ask the sleep plan for an alarm that only a code stops: they store the barcodes or QR codes
of things away from the bed, and every sleep alarm then rings until one of them is scanned, also after the person
silenced the system's alert and also when they open the app. After ten minutes of ringing they may tap 200 times
instead. The sleep alarms themselves are decided in Kotlin and rung through AlarmKit behind a port
(`2026-11-26-sleep-alarms-ring-on-the-device-through-alarmkit`); the camera and the sound are device frameworks, which
stay behind CoreKit adapters (`2026-11-16-recording-and-playback-use-avfoundation-behind-kotlin-facing-ports`); screens
are shared ViewModels bridged by CoreKit (`2026-10-24-shared-screen-viewmodel-lifecycle-and-native-hosting`) and
navigation belongs to the app (`2026-10-24-app-owned-mobile-navigation-through-feature-routers`). AlarmKit's system alert
can be silenced with its Stop button, so something has to ring again without the app running.

## Decision

- **The rules are shared code.** `WakeCodes` (what a code is, which scans count) and `WakeMissionRules` (the watch
  alarms every minute from one to thirty minutes after the ring and then every five minutes up to two hours, the 36 hour
  horizon within which they are scheduled, the ten minute fallback delay, the 200 taps, which mission rings) live in
  `:shared:domain`. `PlanSleepAlarms` chooses between a plain alarm and a mission by the active codes, replaces a mission
  whose codes are not the active ones in any order, and never cancels a mission whose ring has come or an alarm that
  rings. Ring instants are read on the wall clock of the device's zone, as for plain alarms.
- **The device keeps what it must.** The wake settings and the missions (the alarm, its watch alarms and the codes it
  was made for) are kept on the device through `WakeStorage` of `:shared:core`, implemented in the user defaults, and
  written only when they change. `WakeMissions` holds them for the whole process; `SleepAlarmSync` and the guard of every
  window share that one instance, because the sync schedules what the guards watch. `DeviceAlarms.schedule` says whether
  the alert opens the guard; removing an alarm stops one that rings.
- **Two ViewModels.** `WakeSettingsViewModel` keeps each change and runs the sync, and `WakeGuardViewModel` shows the
  guard while a mission rings. The guard waits with one delay to the next ring or to the opening of the fallback,
  restarts when the missions change and polls nothing. Both are `appleOnly`; their state holds typed values, the numbers
  of the rules for the copy, and no text.
- **Native adapters.** `DeviceAlarmScheduler` gives a mission's alert a second button whose `OpenWakeGuardIntent` opens
  the app. `DeviceCodeScanner` reads codes with AVFoundation and hands them over as `AsyncStream`s, the camera frames
  for a preview drawn in SwiftUI with them, with no task per frame. `DeviceAlarmBeep` plays the app's own beep with
  `AVAudioEngine`. `AppIntents` and `VideoToolbox` are added to `apple.systemModules`, `NSCameraUsageDescription` to the
  app and the camera to the macOS sandbox.
- **One guard per window.** The scene covers its window with the guard while its own model says a mission rings; the
  camera and the sound run only while that scene is the active one. When ringing starts, the scene closes every sheet
  with `NavigationContext.dismissAllPresented()`, and its navigation opens nothing until the guard is gone, so a tapped
  notification cannot put a screen above it. The wake settings are reached through `SleepRouting.showWakeSettings()`,
  which the app implements with a new `AppDestination`.

## Consequences

- The wake settings are a sheet of the same tab stack that presents the sleep sheet, and a stack has one sheet at a
  time, so they take the place of the sleep sheet and Done returns to the tab.
- Missions need as many system alarms as the watch alarms, 49 for each mission inside the horizon. AlarmKit lets an app
  hold a limited number, so with several mornings inside the horizon the later watch alarms are refused, which the wake
  settings report; the mission still rings at its ring.
- Real ringing, the alert's second button, the camera and the beep run only on a device; the rules, the sync, the
  ViewModels and the bridges are tested without one. Whether a system alert opens the app through an intent that lives in
  a framework target is confirmed only by running the app.
- A mission rings until a code or the taps end it, however late the person opens the app; tapping is the way out when a
  code is lost.
- Android has no counterpart; it would implement `DeviceAlarms` and `WakeStorage` with its own frameworks.
- Holding the volume up while a mission rings is not part of this decision.
