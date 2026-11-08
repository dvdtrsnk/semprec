-- Renaming title to heading, release N: add the new column. The release's code writes both
-- columns and still reads title; a later release reads heading, and only the release after that
-- drops title (see rejected/rename-column.sql for the one-step version).
ALTER TABLE notes ADD COLUMN heading text;
