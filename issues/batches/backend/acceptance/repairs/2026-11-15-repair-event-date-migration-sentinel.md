# Repair receipt: repair-event-date-migration-sentinel

**Date:** 2026-11-15

A repair of a test on the integration tip. It was made by the controller directly, without a repair branch, because it is
one literal in one test. No independent reviewer read it (NOT RUN).

- Integration tip before the repair: `6d8c3ba27` ("Complete sp-02092440-a57e-4988-be46-883d22cfe3d3 on the integration branch").
- Files changed: one test file under `backend/`, nothing under `issues/` other than this receipt and no production file.
  - `backend/packages/data/src/calendar/__tests__/eventDateMigration.test.ts`

## Failing test as the hosted CI reported it

Pull request 2070 at `86f133c57`, job `integration-shard (1)` (shard 1 of 14), the only failure of 64 files:

| File (under `backend/`) | Test | Failure |
| --- | --- | --- |
| `packages/data/src/calendar/__tests__/eventDateMigration.test.ts` | the Events 1.0.0 to 1.1.0 data migration (issue gh-1797) > leaves an unreadable date and a row that needs no conversion as they are, and logs the id and nothing else | `AssertionError: expected '[[{"itemId":"0a38fa52-04d7-4491-9987-…' not to contain 'abc'` at line 338 |

The file passed 10 of 10 on the controller's host, alone, before and after the change.

## Cause

The fixture row "Text" stores the unreadable date `"abc"` and the last assertion checks that the logged calls do not
contain `"abc"`. The migration logs item ids, which are random UUIDs; a hexadecimal UUID contains the three characters
`abc` by chance. In the failing run the logged id was `a6268ae1-3177-4b05-af86-9056d702aabc`. With four logged ids per
run the chance is about one to three percent per run, so the test is flaky by construction. It has been so since
the commit that added it (gh-1797, `f014d207e`); no later source caused it.

## What was changed and how the test can still fail

The unreadable date of the fixture is now `"no-such-date"`, which cannot be part of a hexadecimal UUID, and the
assertion looks for that value. The assertion still fails when the migration logs the stored value: that follows from
the assertion itself, but it was not mutated (NOT RUN). The test passed 10 of 10 three times in a row, and prettier and
eslint are clean on the file.

## Not repaired

- Other tests with a negative containment check of a hexadecimal word: the search found `logger.unit.test.ts` (`abc123`
  in serialized records without random ids) and two decimal-only checks; none is exposed to random UUIDs, so none was changed.

## Gate

| Step | Result |
| --- | --- |
| `vitest run` of the changed file (three runs) | PASS (10 of 10 each) |
| `prettier --check` of the changed file | PASS |
| `eslint` of the changed file | PASS |
| Full integration tier on the merged tree | NOT RUN (the hosted CI of the pull request is the canonical run) |
| Independent review | NOT RUN |
