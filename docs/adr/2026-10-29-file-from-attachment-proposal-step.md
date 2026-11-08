---
status: accepted
date: 2026-10-29
area: [backend]
supersedes: []
superseded-by: null
---

# A proposal step may move an Inbox attachment into Files

## Context

[[2026-10-25-multi-step-proposal-envelope]] fixes the shape of a multi-step envelope and names three step
kinds: `create`, `update` and `link`. A confirmed Inbox proposal that files a photo or a document needs a
fourth: moving an attachment that the Inbox item carries (`inbox_attachments`, #1564) into the Files
database, in the same confirm transaction as the card's other steps, so that a later step can refer to the
Files item by `{ ref }`. No existing kind expresses it: a `create` step writes database properties, and the
attachment id is not one of them.

A move is not a copy. The attachment row is deleted, and the blob it named stays, because the Files item
names it. The extension keeps the envelope shape of the record above: it adds a value of `op`, no field to
the envelope.

## Decision

A step may have `op: "fileFromAttachment"`.

- **Shape.** The step names neither `databaseKey` nor `itemId`: it writes the system Files database. Its
  `properties` are exactly `attachmentId` (the id of an attachment row), `name` (non-empty) and an optional
  `date`. Any other property, `file` and `type` included, is a 400 that names the step `ref` and the field.
  It may carry `relations` the way a `create` step does, with the Files database's own relation keys.
- **Not primary.** The step is never the `role: primary` step. The envelope's top-level `properties` mirror
  the primary step and are checked against the target database's properties, and `attachmentId` is not one.
- **Validation** checks the shape above and the relations. Confirm runs it through `assertValidProposalEnvelope`, as it does for every step.
- **Confirm** checks that the attachment belongs to the proposal's source Inbox item: the item the card's
  `sourceInbox` edge names. A transcript card names no such item for this purpose, so its file steps are
  refused. An attachment of another Inbox item, an unknown id, or a card with no source item is a 400
  `validation_failed`, and nothing is written.
- **Reuse.** If a live Files item already names the attachment's blob, the step resolves to that item and
  changes none of its properties or relations.
- **Create.** Otherwise the step creates a Files item through the choke point with `file: { blobId }`, the
  given `name` and `date`, and `type` set when the blob's mime type maps to a Files type that the Files
  `type` select offers. The mapping is in `filesTypeForMimeType` (`backend/packages/data/src/blobs/fileTypeDetection.ts`).
  When no such type exists, `type` is not set.
- **Move.** The step then deletes the attachment row. The blob is not deleted by the step. The Files item,
  new or existing, names it, so the blob stays while that item lives.
- **Concurrency.** Before it looks for a live Files item, the step takes a row lock on the blob. A confirm
  that files the same bytes at the same time waits until the first transaction ends. If the first one
  committed, the waiting confirm finds the item it created and reuses it; if it rolled back, the waiting
  confirm creates its own. A delete that finds no attachment row, because another confirm moved it first,
  is a 409 and the caller's transaction rolls back.
- **Origin.** An item the step creates gets an `item_origins` row with capture channel `inbox`, like every
  item a confirm creates (#1659). A resolved existing item gets none.
- **Transcription.** The Files transcription trigger skips a Files item that has an `inbox` origin row. An
  audio attachment moved into Files is not transcribed by that trigger; proposing its transcription is a
  separate decision (#1978).
- **Step result.** The executor returns, for each such step, the Files item id, the moved attachment id and
  whether the step created the item. Storing per-step results is #1648's; the undo of a confirmation
  ([[2026-10-25-undoing-a-confirmed-proposal-reverses-its-recorded-writes]]) reads them from there.

## Alternatives rejected

- A `create` step into Files with an extra property naming the attachment. The envelope would carry a
  property the Files database does not have, and the validator would have to special-case it anyway.
- Moving the attachment in a separate proposal after the first confirm. The multi-step ADR rejects child
  proposals for the same reasons: they are not atomic and double the cards for one source.

## Consequences

- The step kinds listed in [[2026-10-25-multi-step-proposal-envelope]] are now `create`, `update`, `link`
  and `fileFromAttachment`. That record is not edited; this one is the extension.
- Ownership of an attachment is checked only at confirm, because the source Inbox item of a card is known
  there. The Inbox tick never computes a file step; a step of this kind reaches a card through a stored
  envelope that a later issue produces.
- The rule that the file step is never the primary step follows from the top-level mirror described above.
  A future kind that writes no database property faces the same constraint.
