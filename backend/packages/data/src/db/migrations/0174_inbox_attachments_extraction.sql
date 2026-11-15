-- Issue gh-1970: the document data the assistant read from a photo attached to an Inbox item
-- (`inbox/attachmentExtraction.ts`): supplier, amount, dates and a suggested file name, as one JSON object, written once
-- by `recordInboxAttachmentExtraction` of the Inbox attachment store when the proposal computation first extracts the
-- attachment. NULL means no extraction is stored, either because none ran yet or because the attachment is not an
-- image with a reduced copy.
--
-- Additive and rollback-safe: one nullable column the previous release never reads or writes, with no default, no
-- constraint and no index, so the migration rewrites no row. A rollback leaves it in place.
ALTER TABLE inbox_attachments
  ADD COLUMN extraction jsonb;
