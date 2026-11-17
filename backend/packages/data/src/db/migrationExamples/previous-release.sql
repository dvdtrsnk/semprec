-- The schema the previous release runs against. The previous release's code (the fixture in
-- migrationCompatibility.test.ts) inserts and reads notes by (id, title) and no longer uses
-- legacy_color, which the release before it stopped reading and writing.
CREATE TABLE notes (
  id integer PRIMARY KEY,
  title varchar(200) NOT NULL,
  legacy_color text
);
