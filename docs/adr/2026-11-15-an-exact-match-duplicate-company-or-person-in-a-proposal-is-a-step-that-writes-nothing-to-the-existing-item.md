---
status: accepted
date: 2026-11-15
area: [backend]
supersedes: []
superseded-by: null
---

# An exact-match duplicate company or person in a proposal is a step that writes nothing to the existing item

## Context

A proposal can only create a record, so capturing "the bakery with registration number X" or
"Lucie, lucie@brainz.cz" for a company or person that already exists would create a second one.
[[2026-10-25-multi-step-proposal-envelope]] gives a proposal several steps (`create`, `update`,
`link`) and requires the top level of the envelope to mirror its primary step. The validation of
multi-step envelopes (`assertValidEnvelopeOperations`) refuses a primary `link` step but accepts a
primary `update`, and an `update` that changes nothing needs no `before` and no `after` from the
model. [[2026-11-01-computed-proposal-updates-capture-server-preconditions]] keeps the refusal of a
lone `update` or `link` in the model's own answer and the refusal of a repeated mutation of one
item. [[2026-10-31-confirmed-proposal-update-preconditions]] makes the confirm lock every `update`
step's item and check it, and
[[2026-10-25-undoing-a-confirmed-proposal-reverses-its-recorded-writes]] makes the undo check the
item of an `update` step.

## Decision

After the model's answer (and after the registered-name step for a company), the computation of the
proposal (`proposalComputation.ts`) looks for an existing record by an exact match only: the same
eight-digit IČO for a company (spaces removed, left-padded with zeros; the check digit is not
examined), the same address normalized with `normalizeEmailAddress` and found in `person_email_index`
for a person. There is no fuzzy matching by name, and phone numbers are not compared.

A hit replaces the `create` of that record by a step that refers to the existing item and writes
nothing to it: no property and no relation edge. The replacement keeps the `alias` of the create it
replaces, so its step `ref` and every `{ alias }` relation target that names it stay valid, and drops
that create's `database`, `properties` and `relations`.

- A nested record (a create that is not the proposal's own) becomes a `link` step.
- The proposal's own record, the first `create` into the type's target database, or the top-level
  `properties` of an answer without `operations`, becomes an `update` step with no `properties` and
  no `relations`. A `link` cannot be primary, and an `update` that changes nothing passes the
  validation unchanged. The server forms it, never the model, which keeps the refusal of the
  model's own lone `update`.

The operation shape of the computation result gets one marker for this. `ProposalComputationOperation`
has an optional `primary: true`, set only by this step; the model's answer schema has no such key, so
it is never read from an answer. `buildProposalSteps` makes the marked operation the primary step
before its existing rule and does not copy the marker into the stored step. `buildProposalEnvelope`
stores a multi-step envelope when the result has more than one operation or any operation is marked
`primary`, so one replaced primary is a one-step envelope whose top-level `properties` are the
primary step's, `{}`. A single unmarked operation is stored as before.

Detection is a read: plain queries in one short transaction that is closed before the computation
returns, never inside a write transaction and never across the gateway call. A hit on a record in the
Trash is not a duplicate: `person_email_index` keeps the addresses of a trashed person, so such a hit
is skipped like an unknown address and the next address is tried, and the lookup of a company reads
only live items. A result that carries `invalidProposal` is returned unchanged.

Two operations that the replacement makes name the same existing item, or a replacement that names the
item of a `link` or `update` the model gave, are left as they are: `prepareComputedUpdates` refuses
the answer as a repeated mutation of one item and the card is stored as `needsClarification`.

Confirming a card whose primary step is such an `update` creates no item: the confirm locks the item,
checks that it still exists and answers it as `resultItemId`. Undoing that confirmation reopens the
card and writes nothing to the item, and it is refused with 409 `version_conflict` once the existing
item has changed after the confirm, because the undo checks the item of an `update` step. Merging
captured values into the existing record stays a separate user action, and how a card presents or
lets the user override such a step is not decided here.

## Alternatives rejected

- **Fuzzy matching by name.** It would propose a wrong existing record for two different companies
  with similar names; an exact registration number or address does not.
- **A primary `link` step.** The validation refuses it and changing that validation is outside this
  decision.
- **Merging the captured values into the existing record.** It writes to a record the person did not
  point at; it stays an explicit user action.
- **A model-chosen replacement.** The model is not shown which records the exact match finds, and a
  model-made lone `update` is refused by the earlier decision.

## Consequences

A proposal for a company or person that exists stores a step that confirm and undo already handle, so
neither changes. The `primary` marker is the only addition to the computation's operation shape.
The lookup of a company scans the Companies items of the tenant because `ico` has no index.
