# gh-1514 Touches decision

## Question

May the missing Books.year validation use the existing per-module pre-write transform registry, adding its implementation, unit tests and composition registration to Touches?

## Options considered

- Leave Touches unchanged: rejected because the required non-numeric year rejection needs code outside the listed files.
- Add exactly the proposed Books transform, its unit tests and domainWriteHooks.ts registration: selected; this delivers the existing acceptance criterion through the accepted mechanism.
- Add generic number-property validation or change library.test.ts assertions: rejected as unnecessary scope expansion or weakening of the existing requirement.

## Decision

DEFECT — add exactly the three missing Touches paths; approve and queue the corrected specification without implementing the Task.

Both blockers gh-1361 and gh-1509 are closed in issues.mjs list; their repository handovers were read. The working tree has registerItemPreWriteTransform in chokePoint/hooks.ts, the Tasks registration in domainWriteHooks.ts, and BOOKS_MODULE_ID = "books" in seed/libraryModuleKeys.ts. domainWriteHooks.ts is the single composition point. The generic writable-property checks do not validate number values; library.test.ts already requires rejection of text year on create and update.

The proposed transform validates only a supplied Books.year: accept a finite number, allow null to clear and an omitted optional value, and return unrelated patches unchanged. Reject invalid types and non-finite numbers with ValidationError naming year (field: "year"); do not coerce strings, add a range or integer restriction, or validate other modules. This satisfies the existing acceptance criterion without changing Task or its integration assertions.

The proposal follows docs/adr/2026-10-29-item-pre-write-transforms-per-module-registry.md and docs/adr/2026-09-30-choke-point-domain-hooks-through-a-per-process-registry.md. The Tasks precedent and its amendment in docs/adr/2026-10-29-tasks-date-and-time-rules-in-pre-write-transform.md were read. No new registry, lifecycle or architecture is introduced, no accepted ADR conflicts or changes, and no external precondition or protected path is involved.

At this tip gh-1514 was closed with implementation proposal f1de955f6bc2164cffefb58106446a9ef065fb5a, although the required validation is absent. Reopen it through the repository CLI before approval and queueing for the authorized repair; preserve the existing handover. No agent:blocked label was present. No implementation, builds or tests are performed in this decision.

## Spec change

Old:

```text
- backend/packages/data/src/__tests__/library.test.ts
```

New:

```text
- backend/packages/data/src/__tests__/library.test.ts
- backend/packages/data/src/library/booksPreWriteTransform.ts (new)
- backend/packages/data/src/library/__tests__/booksPreWriteTransform.unit.test.ts (new)
- backend/packages/data/src/domainWriteHooks.ts (Books pre-write transform import and registration)
```

## Actor

claude-delegated-by-david

## Model

gpt-6-astra

## Date

2026-10-30
