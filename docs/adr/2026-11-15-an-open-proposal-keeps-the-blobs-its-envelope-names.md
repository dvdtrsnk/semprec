---
status: accepted
date: 2026-11-15
area: [backend]
supersedes: []
superseded-by: null
---

# An open proposal keeps the blobs its envelope names

## Context

`blobsUnreferencedSweep` deletes every standalone upload blob (storage key `<tenantId>/blobs/...`) that is older than
24 hours and that nothing references (`deleteBlobIfUnreferenced`, extended by
[[2026-11-01-blob-reference-writes-coordinate-with-collection]]). A reference is an item's `file` or `image` property,
a mail or Inbox attachment row or a message speech row.

A recipe card computed from a link stores the photo of the page as a blob of its own and names it in its envelope
(`properties.photo.blobId`, issue gh-1974). Until the card is confirmed no item holds that reference: the envelope sits
in the JSON of a Processing proposal. An Inbox card waits for the person, so a card confirmed more than 24 hours after
its computation would find the blob swept, and the confirm would fail on `photo must reference an image blob` with the
photo gone.

The page of the link cannot be fetched again at confirm: the confirm is one database transaction, and a request to a
third party inside it would hold the card and the target's rows for as long as that party takes (io-hardening). The
request is made by [[2026-10-16-connect-time-outbound-address-checks]]'s client at computation time, outside any
transaction.

## Decision

- **A reference.** `deleteBlobIfUnreferenced` also counts a Processing proposal as a reference to a blob when the
  card is open and its `proposal` or its `aiProposal` envelope names the blob's id anywhere in its JSON. The check
  finds the id as text, case-insensitively, so it needs no knowledge of the envelope kind, of a step or of a property
  key and cannot miss a spelling of the UUID. A card is open unless its `status` is `confirmed` (the created item holds
  the reference from then on) or `rejected` (it writes nothing); the two values are `CLOSED_PROPOSAL_STATUSES`, which a
  test keeps equal to `LOCKED_PROPOSAL_STATUSES`. A card that is `invalid`, `needsClarification` or in the trash still
  counts, as the trash purge's other references do.
- **The lock.** `assertValidProposalEnvelope`, which every write of an envelope passes (the tick, a revise, a value edit,
  the confirm), takes `FOR KEY SHARE` on each blob a `file` or `image` property of the target names, in id order and in
  the transaction that stores the envelope. A collection that had already chosen the blob holds the row `FOR UPDATE`
  and decides on a fresh statement, so the card is seen once it commits. This is the lock of the item write's own hook
  in [[2026-11-01-blob-reference-writes-coordinate-with-collection]], taken earlier. A blob that does not exist is not
  refused here; the write of the created item refuses it, as before.
- **The end.** A rejected card no longer counts, so its photo blob is collected by the next sweep after its 24 hours
  have passed. A confirmed card hands the reference to the created item in the same transaction.

## Alternatives rejected

- **A key prefix the sweep ignores.** `findOrCreateBlob` answers an existing blob of the same content with its first
  storage key, so the photo may be a standalone blob whatever prefix the writer chose; and a prefix nothing collects
  leaks the bytes of every dismissed card.
- **Keep the URL and fetch at confirm.** A network request inside the confirm transaction, which io-hardening forbids,
  and a changed page at confirm time would write something other than what the person saw.
- **A reference table for proposals.** A wider schema change than the problem needs; the envelope already is the
  reference, and the sweep is a daily job whose scan of the open cards is cheap.

## Consequences

- A blob that an open card names is never swept, so a card that is never closed keeps its photo.
- The scan reads the open cards of the Processing proposals database once per candidate blob; only blobs older than 24
  hours reach it.
- One interval is not closed: when the photo is a standalone blob older than 24 hours that a sweep has already
  chosen (the same bytes stored by an earlier, rejected card) and the sweep deletes it before the new card's lock is
  granted, the card commits naming a blob that no longer exists. Its confirm refuses with the `ValidationError` on
  `photo`, loudly, and the person can edit the photo out of the card. The window is the time between the sweep's
  choice and its delete.
