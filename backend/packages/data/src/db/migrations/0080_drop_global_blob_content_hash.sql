-- Migration 0064 added tenant-scoped content-hash uniqueness, and findOrCreateBlob has
-- used targetless ON CONFLICT since that expansion. Relax the surviving global constraint:
-- identical bytes in another tenant must neither prevent an upload nor reveal their presence.
DROP INDEX IF EXISTS blobs_content_hash_uq;
