---
status: accepted
date: 2026-11-09
area: [backend]
supersedes: []
superseded-by: null
---

# The nightly Tasks rollover excludes a task already in its result state for today

## Context

[[2026-11-08-nightly-task-rollover-writes-user-owned-schedule]] selects a task by its effective day: `effectiveDate`
when set, otherwise `date` (the interim rule until #1780 and #1798). It also states that "a moved task's day is today,
so it is no candidate again that day". That holds only for the `date` fallback.

The rollover writes `date`, `timeFrom` and `timeTo`; it does not own `effectiveDate`, which #1780 will derive. A task
whose `effectiveDate` is set and in the past therefore keeps matching after its move. The second pass restarts from
the first id after every chunk and stops only on an empty chunk, so it writes such a task again in each of up to
`MAX_SWEEP_CHUNKS_PER_TENANT` chunks. A second run on the same day writes it again too. A full chunk of such tasks can
spend the whole second-pass cap, so a row skipped while locked in the first pass is left unmoved.

Three alternatives were rejected:

- Also requiring `date` before today would stop a future-dated task with a past `effectiveDate` from moving at all,
  which narrows the approved effective-day selection.
- Excluding every task dated today would never clear the times of a timed task dated today whose `effectiveDate` is
  past.
- Writing `effectiveDate` from the rollover would make the rollover a second writer of a field #1780 owns.

## Decision

- A task already in the state the rollover writes for `today` — `date` equal to today, and neither `timeFrom` nor
  `timeTo` set — is not a candidate, whatever its `effectiveDate`. The condition is part of the candidate query in
  `tasks/tasksDayRolloverAction.ts`. Every other row keeps the effective-day selection unchanged.
- This narrows the sentence of [[2026-11-08-nightly-task-rollover-writes-user-owned-schedule]] quoted above. It does
  not replace that record, and that record's text is unchanged.

## Consequences

- A moved task stops qualifying after its own write, so each task is written once per day. The second pass ends
  when the real candidates are moved, and a rerun on the same day writes nothing.
- A task dated today with times and a past `effectiveDate` is moved once: its times are cleared, its date stays.
- The rule follows from the values the rollover writes. If the rollover's write ever changes (for example #1677
  adding the `missed` status), this condition must change with it.
- `effectiveDate` and `hiddenUntil` still have no production writer; tests set them synthetically. Relative-day
  tests do not prove a clock advance.
