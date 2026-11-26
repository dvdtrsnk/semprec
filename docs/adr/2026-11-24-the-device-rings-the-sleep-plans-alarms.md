---
status: accepted
date: 2026-11-24
area: [mobile]
supersedes: []
superseded-by: null
---

# The device rings the sleep plan's alarms, with a code when the person asks for one

## Context

The sleep epic (#1335) decided that the alarm of a resolved night is "scheduled on the phone" and that the server
sends the phone a silent `sleepResync` push after every change of the sleep data, but no client scheduled one: the
`alarm` of a plan or a night rang nowhere. [[2026-11-24-apple-app-rings-system-alarms-through-alarmkit]] gave the Apple
app AlarmKit, and [[2026-11-24-wake-up-alarms-ring-until-a-code-is-scanned]] gave it wake-up missions that ring until a
code is scanned, created only from the debug tool and leaving the sleep plan's alarms for a later decision. The person
wants the sleep settings to offer waking up with a code.

## Decision

- The shared layer decides which alarms the device rings: `LoadSleepAlarms` reads the settings and the resolved nights
  from the evening before today for a week, and answers the nights whose alarm is on while the sleep plan is on, each
  ringing on the day after its evening at its wake time. `DeviceSleepAlarms` of `DevicePushSDK` carries them to the
  device and recognises the `sleepResync` push.
- The Apple app's `SleepAlarmClock` keeps the system's alarms in step with that answer, keyed by the ring
  (`sleep:<wake day> <time>`): it schedules what is missing and removes what the plan no longer has, never an alarm
  ringing now, and keeps what it scheduled across launches. A failed read keeps the alarms the device holds. It runs
  when a signed-in scene appears, when the app becomes active, on a `sleepResync` push and when the wake settings
  change; signing out removes the alarms.
- Without a code the alarms are plain system alarms. With "stop only with a code" on and at least one code, each is a
  wake-up mission of the `WakeGuard` with those codes; a mission's watch alarms are scheduled once its ring is within
  `WakeMission.armHorizon` (36 hours), so a week of alarms stays within what the system allows an app.
- The wake settings (the switch and the codes) are kept on the device, not on the server: a code belongs to a thing in
  the person's home, and the device is what rings. The sleep sheet opens them through a screen the app hands the Sleep
  feature, so the feature imports nothing of the app: `SleepScreenFactory` takes an optional
  `@MainActor () -> AnyView` builder, the only view a feature module is handed from outside, type-erased because
  the feature cannot name the app's `SleepWakeScreen`; nil hides the row. `SleepWakeScreen` is driven by
  `SleepAlarmClock`, a native `ObservableObject` rather than a shared ViewModel: it holds only this device's settings
  and alarms and none of the person's data on the server, which is the exception of
  [[2026-11-24-apple-app-rings-system-alarms-through-alarmkit]].
- The alarms ring with the system's alarm sound and without snooze; the sleep settings' sound and snooze are not
  applied on the device yet.

## Consequences

- A change made elsewhere reaches the alarms through the push or the next time the app becomes active; with neither,
  the alarms of the last read ring.
- The watch alarms of a ring more than 36 hours ahead are scheduled only when the app runs within 36 hours of it; the
  alarm itself rings regardless.
- Android rings no sleep alarm; it needs its own scheduler and decision.
