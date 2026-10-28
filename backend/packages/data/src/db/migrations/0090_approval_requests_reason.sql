-- Issue #1420: the agent's own explanation of why it asks for approval.
--
-- Additive and rollback-safe: one nullable column the previous release neither reads nor writes
-- (its `SELECT *` mapping ignores unknown columns). NULL means the agent gave no reason. The
-- 500-character cap mirrors the limit the agent tool wrapper enforces before an insert.
ALTER TABLE approval_requests
  ADD COLUMN reason text NULL
  CONSTRAINT approval_requests_reason_length_check CHECK (reason IS NULL OR char_length(reason) <= 500);
