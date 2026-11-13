-- Issue #1860: the typed step summary, the turn duration and the token totals of a Semp reply, stored when its turn ends.
-- Additive: all three are nullable, because a reply whose turn has not finished (and every message written before
-- this migration) has none of them. The previous release never reads or writes them.
ALTER TABLE semp_messages ADD COLUMN steps jsonb;
ALTER TABLE semp_messages ADD COLUMN duration_ms integer;
ALTER TABLE semp_messages ADD COLUMN tokens jsonb;
