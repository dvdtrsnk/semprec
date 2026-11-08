-- A rename is a drop in disguise: the previous release still names title.
ALTER TABLE notes RENAME COLUMN title TO heading;
