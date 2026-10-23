-- A new table no previous release knows about, so its own constraints can be as strict as needed.
CREATE TABLE note_tags (
  note_id integer NOT NULL REFERENCES notes (id),
  tag text NOT NULL,
  PRIMARY KEY (note_id, tag)
);
