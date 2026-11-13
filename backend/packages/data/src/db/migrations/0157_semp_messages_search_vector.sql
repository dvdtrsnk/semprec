-- Issue #1783: full-text search over the text of Semp messages. Additive only: one nullable column
-- and one index, so the previous release's code, which neither reads nor writes the column, is
-- unaffected.
--
-- search_vector holds to_tsvector('czech', text) || to_tsvector('czech_simple', text) of a
-- non-system message that has text, and is NULL for a system message and for a message whose text
-- is not written yet. The application maintains it on every write of message text
-- (semp/sempMessageSearch.ts). The messages that exist before this migration are filled by
-- reindexSempMessageSearch, in batches, not here.
ALTER TABLE semp_messages ADD COLUMN search_vector tsvector;

CREATE INDEX semp_messages_search_vector_idx ON semp_messages USING gin (search_vector);
