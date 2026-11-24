---
status: accepted
date: 2026-11-24
area: [mobile]
supersedes: []
superseded-by: null
---

# The Apple app rings system alarms through AlarmKit, tried from a native debug menu

## Context

The sleep plans and nights carry an `alarm` flag (#1784, #1835), and the sleep sheet lets the person turn an alarm
on, but nothing on the device rang. A local notification cannot be a wake-up alarm: it is silenced by silent mode and
held back by a Focus. iOS and iPadOS 26 have AlarmKit, which schedules alarms that the system rings like the Clock
app's: through silent mode and a Focus, on the Lock Screen, in StandBy and on a paired Apple Watch, after the person
allowed alarms for the app (`NSAlarmKitUsageDescription`). macOS has no AlarmKit. An alarm with a countdown (a timer,
or the snooze that counts down to the next ring) must have a Live Activity in a widget extension, or the system may
drop it.

`apple.systemModules` in `mobile/scripts/architecture-policy.json` did not list `AlarmKit`.
[[2026-10-24-kotlin-multiplatform-below-native-mobile-ui]] puts every screen's state and decisions in a shared
ViewModel and allows a platform branch only where iOS and macOS genuinely differ. Before the alarms of the sleep plans
are wired, the person wants to try AlarmKit itself on the iPhone (permission, an alarm once or every day, an alarm a
few seconds ahead with the phone locked) from a debug menu.

## Decision

- `AlarmKit` is an allowed system module. Only `SystemAlarmScheduler` in the app target imports it, behind the
  app's `AlarmScheduler` protocol (`Projects/App/Sources/Alarms/`), which exchanges plain values (`AlarmRequest`,
  `AlarmTime`, `ScheduledAlarm`, `AlarmAuthorization`), so no other code holds an AlarmKit type. Its
  `#if os(iOS)` is the platform branch: on macOS the same type reports `unsupported` and schedules nothing. It is in
  the app target, not DesignSystem, because it is a system service, as `AppNotifications` is.
- Alarms are scheduled with a fixed date (once) or a relative time repeating on all seven weekdays (every day), and
  without a countdown duration, so there is no snooze and no Live Activity, and the app has no widget extension.
  Stopping an alarm is the system's own button; no App Intent runs.
- The app has a debug menu, a page of the profile sheet's stack (`ProfileSheetPage.debug`), opened by a toolbar
  button the app adds to the profile. Its first tool, `DebugAlarmScreen`, is driven by a native `ObservableObject`
  (`DebugAlarmViewModel`) over `AlarmScheduler`, without a shared ViewModel. This narrows the shared-ViewModel rule of
  [[2026-10-24-kotlin-multiplatform-below-native-mobile-ui]] for debug tools only: a debug tool exercises a platform
  API and decides nothing about the person's data, so there is nothing to share with Android. A screen that reads or
  writes the person's data still gets a shared ViewModel.
- The debug menu is in every build, Release included, because the app is tried on the iPhone from Ad Hoc builds.

## Consequences

- Wiring the sleep plans' alarms means a shared decision of which alarms the device should hold (like
  `DeviceNotificationService` for reminders) carried to the system through `AlarmScheduler`; the debug screen stays a
  test tool beside it.
- A snooze, a timer or a custom alarm button needs a widget extension target with an AlarmKit Live Activity and its
  own App ID and provisioning profile, and a new decision.
- Android has no counterpart; it would need its own alarm API (`AlarmManager.setAlarmClock`) and a decision of its
  own.
- Hiding the debug menu from builds for other people is open until the app has such builds.
