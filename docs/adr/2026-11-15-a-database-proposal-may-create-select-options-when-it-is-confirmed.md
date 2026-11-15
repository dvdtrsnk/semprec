---
status: accepted
date: 2026-11-15
area: [backend]
supersedes: []
superseded-by: null
---

# A database proposal may create select options when it is confirmed

## Context

An Inbox proposal fills the properties of one item of a target database. For a `select` or `multi_select` property
the value must be a key of an option the property already has
(`assertSelectValuesKnown`, applied to every envelope and step by the proposal validation), and the grounding of
gh-1990 lists those keys for the model. When a note names a tag that does not exist ("Herbs" in Health records) the
proposal cannot carry it, and the assistant has no way to create the option: the options of a schema-locked database
change only through `property.option.add`, which is REST-only so that a person, and not an agent, adds the option
([[2026-11-10-select-options-change-on-a-schema-locked-database]], section 7, which names this decision as the way the
assistant gets a new option).

That ADR leaves the way open and records its constraint: a schema change is made by a person. The confirm of a card
is a person's decision and already writes under the user's authority ([[2026-09-10-agent-writes-are-proposals-not-direct-writes]]),
so a proposal that carries the option and a confirm that creates it keeps that rule.

## Decision

- **The envelope.** A single-step `database` envelope may carry `newOptions`, a list of `{ propertyKey, label, color? }`
  (`proposalNewOptionSchema`). A value of `properties` names a new option by its label as `{ newOption: "<label>" }`,
  in the place of an option key: the whole value of a `select` property, or an element of the array of a
  `multi_select` property. The schema checks only the shape, so an envelope that breaks a rule below still parses and is
  refused with a message.
- **Where it is valid.** Only on an envelope of `entityKind: "database"` without `operations`
  (`assertValidEnvelopeNewOptionsPlacement`, called first by `assertValidProposalEnvelope`); anywhere else a
  `ValidationError` on `newOptions`. A multi-step envelope names several created items, and a value would not say which
  step's property the option joins. An envelope without `newOptions` is validated and confirmed as it was.
- **Validation** (`assertValidEnvelopeNewOptions`, run by the Inbox tick, a revise and the confirm through
  `assertValidProposalEnvelope`): at most 3 options (`MAX_PROPOSAL_NEW_OPTIONS`, `new_option_limit`); each on a
  `select` or `multi_select` property of the target database; a label of 1 to 60 characters and, when given, a `#RRGGBB`
  color, by the schema of `property.option.add`; no label listed twice for one property, compared as the option add
  compares labels; no label that another option of the property has, which is `OptionLabelExistsError` (409
  `option_label_exists`, `details.key` the existing option) so the proposal can use that option, checked for the
  listed options that a value names only: a listed option that no value names is ignored by the confirm and is not
  checked for its label, so a card whose value was changed to an existing option stays valid with the list as it is;
  and every `{ newOption }` value naming a listed option of the same property by its trimmed label. The check reads the
  property as the target's row holds it, without a lock. The tick, and the check that decides whether a stored card is still valid
  (`storedEnvelopeStillValid`), treat `OptionLabelExistsError` as a refusal of the envelope like a `ValidationError`: a
  computed answer whose label is taken becomes a `needsClarification` card, and a stored card whose label has been taken
  since is no longer valid.
- **Confirm** (`createEnvelopeNewOptions`, in `confirmProposalWithClient`): after the envelope has been validated and
  before the item is created, each listed option that a value of the written properties names is added to its property
  on the confirm's client and its generated key replaces the `{ newOption }` value; then the item is created as before.
  The add is `propertiesStore.addPropertyOption`, the store function behind `property.option.add`: it locks the property
  row until the confirm's transaction ends and applies the label, limit and key rules there, so a label that an option
  took since the validation is refused with `option_label_exists` and the confirm rolls back. After the commit the
  schema invalidation of the database is sent, as the operation sends it. A listed option that no value names is not
  created: a person who changed the value on the card to another option leaves it out. The option is created once, at
  its first use, however many times a value names it.
- **Atomicity.** The options, the item and the confirmed card are written in the one transaction of the confirm. A
  failure after an option was added, the item write's included, rolls the option back with it. A rejected card and a
  card that is already `confirmed` (answered from the card without a write) create no option, so a repeated confirm
  creates one option and one item.
- **Computation.** `ProposalComputationResult.newOptions` is copied to the envelope of a single-step `database` answer
  and ignored for a multi-step answer. The system message of the proposal request tells the model, only when the
  request carries the option catalog of gh-1990, that it may propose a new option when no listed option fits, and the
  response schema lists the field.

## Revise, reopen and values edits

- **Revise.** A revise (`POST /api/proposals/:id/revise`, `inbox.proposal.revise`) composes its envelope from the
  properties it is given, so `carryNewOptions` carries over the `newOptions` of the card's previous assistant envelope
  the way `carryPageSections` carries the page sections: only the options that a value of the revision still names, and
  only when the destination is kept (a single-step `database` envelope with the same target). A revision that drops the
  value drops the option; a revision that names a label the card never listed is refused on the property.
- **Reopen.** Reopening a confirmed card (`POST /api/proposals/:id/reopen`) reverses the item and the edges and
  leaves the options the confirm created in the schema: an option is a schema change the undo does not take back, and
  the item that used it is the only thing the undo owns. The card returns to `proposed` with the option used by its
  key: `adoptCreatedNewOptions` replaces, in the `proposal`, the `aiProposal` and the `userOverrides`, each `{ newOption }`
  value whose listed option an option of the property now has by label with that option's key, and drops the option
  from `newOptions`. The card can be confirmed again, creates no second option and writes the same key.
- **Values edit.** A values edit (`PATCH /api/proposals/:id/values`) keeps `newOptions`. When a label was taken after
  the card was computed (a person added the option), setting the value to the existing key makes the card valid and
  confirmable, because the listed option no value names is no longer checked.

## Differences from the operation

The confirm adds the option through the store function of `property.option.add` and not through the operation:

- The operation opens its own transaction, and `chokePoint/propertyOps.ts` cannot be imported from `inbox/`: it imports the search
  backfill, which imports the tenant provisioning, which imports the Inbox, and `no-choke-point-rollup-cycle` forbids
  that cycle.
- For the same reason the confirm queues no search reindex of the database. The reindex exists because the search
  documents of the items that hold an option contain its label; no item holds a new option, and the item the confirm
  writes is written after the option, so its document is built from a property that already has the option.

## Alternatives rejected

- **An agent tool that adds an option.** [[2026-11-10-select-options-change-on-a-schema-locked-database]] keeps
  `property.option.add` out of the agent and MCP transports so that a person decides; a tool would undo that.
- **A step kind for the schema change.** A step writes an item and the envelope's primary step mirrors the top-level
  properties; an option is neither, and a step could not be switched off by the person without leaving a dangling value.
- **Creating the option when the card is computed.** A discarded card would leave an option behind in a schema the
  person never approved.

## Consequences

- A card that carries a new option shows, in its stored `proposal`, the label in the place of a key; a client that
  renders the properties of an envelope has to read `{ newOption }` (the card design is outside this decision).
- An option created by a confirm outlives the undo of that confirm: a reopened card uses it by key (see "Revise,
  reopen and values edits") and the option can be removed only as any option is.
- The schema invalidation carries the acting user the confirm was given (`actingUserId`), so it reaches that user's own
  sockets, as the invalidation of `property.option.add` does; a confirm without an acting user sends it to every socket
  of the tenant.
