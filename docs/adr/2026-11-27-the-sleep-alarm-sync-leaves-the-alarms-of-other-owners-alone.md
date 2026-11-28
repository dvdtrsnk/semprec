---
status: accepted
date: 2026-11-27
area: [mobile]
supersedes: []
superseded-by: null
---

# The sleep alarm sync leaves the alarms of other owners alone

## Context

`docs/adr/2026-11-26-sleep-alarms-ring-on-the-device-through-alarmkit.md` lets the sleep alarm sync remove every alarm
of the app that its ledger does not know, "so the app's alarms are exactly the sleep plan's". That held while the sleep
plan was the only thing that rang alarms. The debug alarm tool (a menu in every build, which the owner uses on Ad Hoc
builds to try the system alarms) rings alarms and wake missions through the same device port, ledger and mission store.
The sync runs whenever a scene appears, the app becomes active or a push arrives, so under the old rule it would remove a
debug alarm minutes after it was rung.

## Decision

An alarm belongs to the sleep plan only when its key is a sleep key (`sleep:` and the moment). `PlanSleepAlarms` keeps a
ledger entry or a wake mission with any other key for as long as the device holds its alarm, and forgets it when the
device no longer does. Everything else about the sync stays as the earlier decision states: it removes the alarms of the
app that no ledger entry or mission names, unless one rings, and it never removes an alarm that rings.

Another owner keeps its alarms in the same ledger and mission store under its own key prefix (`debug:`), takes the same
lock (`WakeMissions.lock`) for every change and never uses a sleep key. A wake mission of another owner is watched by the
guard and armed with watch alarms like a sleep mission, because it is the same mission.

## Alternatives considered

- **A second ledger and a second mission store for the debug tool.** The guard watches one store, and the sync would
  still remove alarms that neither of its stores names, so it would have to be told about the other store anyway.
- **Skipping the sync while the debug tool is open.** The tool is a screen of one window, the sync is the process's, and
  a ring a minute away outlives the screen.
- **Leaving the debug alarms to be removed.** Every alarm tried from the menu would disappear at the next launch of a
  scene, which makes the menu useless for testing a locked phone.

## Consequences

- A key that is not a sleep key is never the sleep plan's, so an owner picks a prefix that no other owner uses; the
  prefixes are `sleep:` and `debug:`.
- An alarm of another owner that the device lost, because it rang and was stopped, drops out of the ledger at the next
  run, like a sleep alarm.
- Removing every alarm of the app from the debug tool also removes the sleep plan's, which the next sleep alarm sync rings
  again.
