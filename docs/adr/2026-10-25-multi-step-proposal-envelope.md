---
status: accepted
date: 2026-10-25
area: [backend]
supersedes: []
superseded-by: null
---

# A proposal envelope may carry several steps, confirmed in one transaction

## Context

[[2026-09-10-agent-writes-are-proposals-not-direct-writes]] makes every agent write a proposal
that a human confirms. The envelope stored on a Processing proposals card is
`{ entityKind, target, properties }` (`proposalEnvelopeSchema` in
`backend/packages/data/src/inbox/inboxTickAction.ts`, a `z.object` that drops unknown keys) and
means exactly one write. `confirmProposalWithClient` (`backend/packages/data/src/inbox/proposalActions.ts`)
locks the proposal row, is idempotent, runs in the caller's one transaction and returns one
`resultItemId` and `resultLabel`. It already writes more than one row atomically in two special
cases (an Event plus its transcript edge; an MCP server plus its credential), but those are
hard-coded per case.

Some sources need more than one write to be useful: a file from an attachment plus a follow-up
task, a company plus a new person, a health record plus a follow-up task, a new area plus moving
a project into it, a transcript speaker mapped to a new person. Relations of single-step
envelopes are added by #1426, and moving an existing item is a step kind of its own. Validation
(#1479) and confirm (#1486) will implement the shape recorded here, and any later composite
proposal must adopt exactly this one shape instead of inventing another.

## Decision

### Shape

The envelope gains an optional `operations` array. Each step has:

| Field | Meaning |
|---|---|
| `ref` | Identifier unique within the proposal (for example `primary`); the key user edits use. |
| `op` | `create`, `update` or `link`. |
| `databaseKey` | The target database, for `create`. |
| `itemId` | The existing item, for `update` and `link`. |
| `properties` | Property values the step writes. |
| `relations` | Relations the step writes; a target is an item id or `{ ref }` naming another step of the same proposal. |
| `role` | `primary` or `secondary`. |
| `optional` | Boolean; see Skipping. |
| `enabled` | Boolean; see Skipping. |

An `update` step also carries `before` and `after` of every relation and property it changes, so
the change can be shown to the user, reverted and audited. An `update` step is a general write of
the existing item's properties and relations through the item-write choke point, under the same
validation, approval and risk rules as any other item update. A project's status is not a special
case.

### Compatibility

A single-step envelope stays valid unchanged. A multi-step envelope keeps the top-level
`entityKind`, `target` and `properties` equal to its primary step, and `operations` lists all
steps including the primary one. Every existing reader, and the `confirm` contract (`resultItemId`
and `resultLabel` are the primary step's result), therefore keep working without knowing about
`operations`.

### Skipping

A step is neither validated nor written when `enabled` is false, or when it is `optional` and
nothing refers to its `ref` any more (a removed "new" chip, another company chosen, another person
chosen). This lets the user edit away a step without leaving a dangling reference.

### Refs

A `{ ref }` names only a step of the same proposal. There are no cycles, and exactly one step has
`role` `primary`. Steps are written in dependency order, so a referenced step exists before the
step that refers to it.

### User edits

User edits address a step by its `ref`; a single-step envelope has the implicit ref `primary`.
That ref is the key `userOverrides` uses.

### Confirm

All enabled steps are written in one transaction under the proposal's row lock, the same lock
`confirmProposalWithClient` takes today. Any failure rolls everything back and answers 400 naming
the `ref` and the `field`. Moving an item to another "one"-side owner is
`deleteRelationWithClient` of the old edge plus `createRelationWithClient` of the new one in that
same transaction. The properties of an `update` step are written with the choke point's item
update in the same transaction.

## Alternatives rejected

- Child proposals created after the first confirm. They are not atomic, can leave half-done work
  if a later one is rejected or fails, and double the cards the user sees for one source.
- Encoding extra steps inside `properties`. It hides structure the validator, the preview and
  the audit need, and every consumer would have to parse a private convention.

Multiple cards for one source remain a separate mechanism, governed by a separate decision on
splitting one source into several cards.

## Consequences

- #1479 will extend the envelope schema and validation, and #1486 will extend confirm; until
  they land the code still handles only the single-step envelope.
- Computing steps in the tick (#1492) and per-step results and origin recording are separate
  issues; this record does not define a per-step result.
- A step added by a future module must use this shape and these rules rather than a new field
  on the envelope.
