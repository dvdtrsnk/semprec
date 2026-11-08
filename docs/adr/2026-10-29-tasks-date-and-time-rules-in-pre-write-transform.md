---
status: accepted
date: 2026-10-29
area: [backend]
supersedes: []
superseded-by: null
---

# Tasks date and time rules are checked by the Tasks pre-write transform

## Context

[[2026-10-29-item-pre-write-transforms-per-module-registry]] attaches Tasks' derived `time` to a pre-write transform. Its rule 5 says that on update the transform stores `time` "only when the patch names `timeFrom` or `timeTo`", and it names the Tasks transform file `tasks/tasksItemPreWriteTransform.ts`.

Before this decision the choke point accepted Tasks values the product does not allow: a start time without a date, an end time without a start time, an end time not later than its start, a blank title, and a date that is not a real day (`2026-02-30`). Clearing the date kept the stored start and end times.

This ADR adds those rules to the Tasks transform. It does not change the registry, and the transform is still the only place that enforces them.

## Decision

The Tasks transform, `tasks/taskPreWriteTransform.ts`, registered under `TASKS_MODULE_ID` in `domainWriteHooks.ts`, judges the resulting state of a create or a patch and stores the values it returns.

1. **Name.** `name`, when the write sends it, must be a string that is not blank after trimming. The value is not rewritten.
2. **Date.** `""` or `null` switches the date off. Any other value must be a `YYYY-MM-DD` calendar day that exists.
3. **Times.** `timeFrom` and `timeTo` are normalized by `normalizeWallClockTime` (`timezone.ts`): `H:MM` or `HH:MM`, zero-padded, `""` meaning no time. `timeTo` also accepts `24:00`.
4. **Schedule.** A start time requires a date. An end time requires a start time and must be later than it. An end time equal to the start is refused with `400` on `timeTo`; it is not turned into `null`.
5. **Switching the date off.** When the resulting date is `null`, the same write sets `timeFrom`, `timeTo` and `time` to `null`. A start or end time sent in that same write is refused, because it would need a date.
6. **Scope on update.** A rule runs only when the patch names a key it reads: the name rule when it names `name`, the time rules when it names `date`, `timeFrom` or `timeTo`. An update that names none of these keys passes through unchanged. A create runs the time rules always.
7. **Derived time.** The transform stores `time` on create always, and on update whenever it runs the time rules. It is computed from the normalized values, by `deriveTaskTime`.

**Amendment of rule 5 of [[2026-10-29-item-pre-write-transforms-per-module-registry]].** On update the transform stores `time` when the patch names `date`, `timeFrom` or `timeTo`. Switching the date off must clear `time` in the same write, so `date` is a key that can change `time`. Rules 1 to 4 of that ADR are unchanged.

**File name.** The Tasks transform file is `tasks/taskPreWriteTransform.ts`. The file named `tasks/tasksItemPreWriteTransform.ts` in the registry ADR's text was renamed by this change. That ADR's text is not edited, so its file reference now names a path that no longer exists.

## Consequences

- An unrelated write (a status change, for example) to a stored row that predates these rules still succeeds. Only a write that names `name`, `date`, `timeFrom` or `timeTo` is checked, and it is checked against the resulting state. The stored invalid values are repaired by #1657, not by this rule.
- A recurring Tasks item whose stored times break these rules fails its `done` write: the recurrence advance copies the times into a new task through the same transform, and the write rolls back. The same applies to a stored blank title copied into the next instance. #1657 is the repair.
- Blank titles from system writers are refused as well. The generic title rule in `chokePoint/itemWrites.ts` exempts system writers; this rule does not.
- The transform reads `stored` under the row lock that the registry ADR already takes for every Tasks update, so the stored values it judges cannot change before the write commits.
