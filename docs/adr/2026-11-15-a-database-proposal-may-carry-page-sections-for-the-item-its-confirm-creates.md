---
status: accepted
date: 2026-11-15
area: [backend]
supersedes: []
superseded-by: null
---

# A database proposal may carry page sections for the item its confirm creates

## Context

A `database` proposal creates one item in a database, and its confirm writes the properties of that item
([[2026-10-25-multi-step-proposal-envelope]] extends it to several items). A `pageContent` proposal writes blocks,
but into a page that already exists: its `target` is that page, and the page of an item that the same confirm creates
has no id yet when the card is computed. Neither shape can say "create this item and give it this page".

A recipe proposed from a link or a photo needs exactly that (issue gh-1974): the recipe is an item of the Recipes
database, and its ingredients and method are the text of its page, not properties.

## Decision

The envelope gains an optional `pageSections` array (`proposalEnvelopeSchema`, `proposalPageSectionSchema`).

- **Shape.** One to four sections. A section is `{ heading, blockType, items }`: `heading` is a trimmed, non-empty
  line of at most 200 characters, `blockType` is `bullet` or `number`, and `items` holds one to 100 strings of one to
  500 characters. Any other key is refused. The texts are plain text, never Markdown: an item that reads like a
  heading, a nested list or a page link is written as the text it is, so a model or a web page cannot shape the blocks
  of the page.
- **Where it is valid.** Only on an envelope of `entityKind: "database"` without `operations`
  (`assertValidEnvelopePageSections`, called first by `assertValidProposalEnvelope`, so the Inbox tick and the confirm
  both refuse the same states). Anywhere else it is a `ValidationError` on the field `pageSections`. A multi-step
  envelope names several created items and the sections would not say which one they belong to.
- **Confirm.** After the item is created, and before its relations, the confirm locks the new item live and appends
  the blocks of every section to the end of its page in one document write authored `user`, in the transaction of the
  confirm: a failure of the write rolls the item back with it. Each section is an `h2` heading block followed by one
  block of the section's type per item. The id of the n-th block of the page, headings and items counted together, is
  `proposalBlockId(proposalId, n)`, so a repeated insert names the same ids instead of adding a second copy. The ids are
  the `blockIds` of the primary step's result.
- **Computation.** `ProposalComputationResult.pageSections` is copied to the envelope of a single-step `database`
  answer and ignored for the other answers. The only producer is the recipe proposal writer (`proposeRecipe`): the
  headings are resolved from the Inbox catalog in the language of the person, and they are stored in the envelope as
  text, so they are the page's content from then on.
- **Editing.** `PATCH /api/proposals/:id/values` edits property values and leaves the sections as the card holds them;
  the effective envelope is the assistant's envelope with the overrides laid over it, which keeps the field.
- **Revising.** A revise (`POST /api/proposals/:id/revise` and the `inbox.proposal.revise` tool of an item thread,
  which also serves the first entry of a split) replaces the whole envelope with one composed from `entityKind`,
  `target`, `properties` and `relations`, which cannot name sections. `carryPageSections` copies the sections of the
  card's previous assistant envelope (`aiProposal`, else `proposal`) onto the revised one when the revision keeps the
  destination: both are single-step `database` envelopes of the same `target` and the revised one has none of its own.
  A revision to another database or kind carries nothing, and an envelope that does not parse carries nothing, since a
  revise may replace it. The carried text is the text the tick wrote, so a revision of a value such as `servings`
  leaves the quantities written in the sections as they were.

## Alternatives rejected

- **A Markdown string.** The ingredients and steps of a page are untrusted text. Rendering them into Markdown and
  parsing it again would let a line start a heading, a todo or a link to another item, and escaping every form is
  fragile. Plain text per block cannot.
- **A new step kind.** A step names an item to write, not blocks of an item another step creates, and the multi-step
  envelope's primary step already mirrors the top-level `properties`. A kind that writes a page would have to name the
  step whose item it targets.
- **A second proposal for the page.** The page does not exist until the first confirm, and two cards for one source
  are neither atomic nor what the person asked for ([[2026-10-29-file-from-attachment-proposal-step]] rejects child
  proposals for the same reasons).

## Consequences

- A producer that wants a page for the item it proposes sets `pageSections` on a single-step `database` answer and
  needs no change to the confirm.
- The sections are not editable through the values route or by a revise, which only keeps them. A person who wants
  other text edits the page after the confirm.
- The envelope field stays in the stored `proposal` and `aiProposal` of the card like the other fields, so a card
  written before this decision parses unchanged.
