-- Issue gh-1965: the facts `semprec-transcribe` computes for an Inbox attachment after it is attached
-- (`inbox/inboxAttachmentMetadata.ts`): `metadata` (the image size, the audio length, when a recording was made, whether
-- it is a voice note or a recording, or the code of the failure to read the file), and the two derived images of a
-- photo, `thumbnail_blob_id` (the 128 px preview) and `reduced_blob_id` (the reduced copy the assistant reads). All
-- three stay NULL until the job has run, and for an attachment the job could not read the blob columns stay NULL.
--
-- Additive and rollback-safe: three nullable columns the previous release never reads or writes, and two indexes. A
-- rollback leaves them in place. The two foreign keys are composite, as 0096's `agent_runs_thread_id_fkey` is, with no
-- single-column key beside them (so they are not tenant twins of the kind 0083 adds), so a blob of another tenant is
-- refused, and apply only to a row whose blob column is set (MATCH SIMPLE). They are added valid, without NOT VALID,
-- because every row's new columns are NULL, so the validation finds no row to check; adding them takes a SHARE ROW
-- EXCLUSIVE lock on `blobs` and on `inbox_attachments` until the migration transaction commits, which blocks writes to
-- both for that short time. `deleteBlobIfUnreferenced` counts the two blob columns as references, so a derived image
-- is kept while an attachment names it, and the indexes serve that lookup.
ALTER TABLE inbox_attachments
  ADD COLUMN metadata jsonb,
  ADD COLUMN thumbnail_blob_id uuid,
  ADD COLUMN reduced_blob_id uuid;
ALTER TABLE inbox_attachments
  ADD CONSTRAINT inbox_attachments_thumbnail_blob_id_fkey
    FOREIGN KEY (tenant_id, thumbnail_blob_id) REFERENCES blobs (tenant_id, id),
  ADD CONSTRAINT inbox_attachments_reduced_blob_id_fkey
    FOREIGN KEY (tenant_id, reduced_blob_id) REFERENCES blobs (tenant_id, id);
CREATE INDEX inbox_attachments_tenant_thumbnail_blob_idx ON inbox_attachments (tenant_id, thumbnail_blob_id);
CREATE INDEX inbox_attachments_tenant_reduced_blob_idx ON inbox_attachments (tenant_id, reduced_blob_id);
