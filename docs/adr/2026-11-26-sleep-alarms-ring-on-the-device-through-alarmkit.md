---
status: accepted
date: 2026-11-26
area: [mobile]
supersedes: []
superseded-by: null
---

# Sleep alarms ring on the device through AlarmKit behind a port that Kotlin owns

## Context

A night of the sleep plan can have its alarm on, and the plan itself can be switched off. The server resolves every
night (`GET /api/sleep/nights`: the evening a night starts, its bed and wake time and whether its alarm is on) and
sends the silent push `kind: sleepResync` when the plan changes. Something on the phone has to ring at the wake time,
also in silent mode and through a Focus, which a local notification does not do and which only the system's alarms
(AlarmKit, iOS and iPadOS 26) do. The Apple app's minimum is 26.0, so AlarmKit needs no availability check apart from
the alert initializer that 26.1 added. macOS has no AlarmKit.

Which alarms exist is a business decision: which nights ring, at which instant (a wake time of 07:00 on the day the
clocks change is still 07:00 on the wall clock), what to do with an alarm that is ringing now, what the plan being off
means. Deciding it in Swift is what the Apple review rules forbid (`DOMAIN-SOURCE`) and what produced a shifted ring
time on the days the clocks change. The Kotlin interface pattern for a platform framework is
`2026-11-16-recording-and-playback-use-avfoundation-behind-kotlin-facing-ports`.

## Decision

- `PlanSleepAlarms` in `:shared:domain` is a pure function of the resolved nights, the time and zone now, and what
  the device holds. A ring is the wake time of a night whose alarm is on, on the day after its evening, read on the
  wall clock of the device's time zone; a ring that has passed is dropped, a key rings once, an alarm that rings now is
  never cancelled, and the plan off cancels the rest. `LoadSleepAlarmNights` reads the plan and the nights of the next
  seven mornings. `kotlinx-datetime` is added to `:shared:domain` for the time zone arithmetic, and none of its types
  is exported: the port takes epoch seconds.
- `DeviceAlarms` in `:shared:core` is what only the platform can do: `authorization()`, `schedule(ringAtEpochSeconds,
  callback)`, `cancel(id)` and `held(callback)`. It has no suspending function and no flow, so that a Swift class can
  implement it and a test can script it; a refusal the app can name is a `DeviceAlarmFailure`, anything else is
  `Failed`. Kotlin calls it on the main thread only. `SleepAlarmLedger` is its sibling: where the app remembers which
  alarm of the device belongs to which ring, because the device's alarms cannot say it. An alarm of the app that the
  ledger does not know is removed too, unless it rings, so the app's alarms are exactly the sleep plan's.
- `SleepAlarmSync` in `:shared:presentation` runs the decision for the whole process, one run at a time: it reads the
  plan, asks the device what it holds, removes and schedules, and keeps the ledger of what it did, also when it is
  cancelled. A plan that cannot be read changes nothing. `DevicePushSDK` exposes it next to `DeviceNotifications`, and
  one parser, `DeviceNotifications.resync(payload)`, tells a silent push for the reminders from one for the sleep alarms.
- `DeviceAlarmScheduler` in CoreKit is the only code that imports AlarmKit, which is added to `apple.systemModules`;
  `#if os(iOS)` sits inside it and macOS answers unsupported. An alarm is a one-off at a fixed date with its alert
  title (and, before iOS 26.1, the Stop button's text) from CoreKit's catalog; it has no countdown, no snooze, no secondary button and no Live
  Activity, so the app needs no widget extension. `NSAlarmKitUsageDescription` is in the app's Info.plist with its
  Czech translation.
- `AppNotifications`, the process's owner of notification work, is given the sleep alarm service and calls it where it
  already refreshes: when a scene shows its tabs and each time it becomes active (a `.task(id:)` on the scene phase),
  on `sleepResync`, and when nobody is signed in.

## Consequences

- Android has no counterpart. It implements `DeviceAlarms` with its own alarm framework when it gets sleep alarms;
  nothing in the shared layer changes.
- The alert, the permission prompt and ringing itself are not exercised by any test here: the decision, the sync and
  the adapter's mappings are, but AlarmKit needs a real device, so they are checked by running the app on one.
- The alarms follow the plan only when the app runs or a push arrives. A device whose time zone changes keeps its
  alarms at the old instants until the next run, which reads the zone again.
- The `alarmSnooze` and `alarmSound` settings do not reach the alert yet.
