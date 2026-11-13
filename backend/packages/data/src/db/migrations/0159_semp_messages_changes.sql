-- Issue #1885: the items a Semp reply changed, stored with the message when its turn ends.
-- Additive: nullable, because a reply whose turn has not finished (and every message written before this
-- migration) has no list; a finished turn that changed nothing stores an empty array. The previous release
-- never reads or writes the column.
ALTER TABLE semp_messages ADD COLUMN changes jsonb;
