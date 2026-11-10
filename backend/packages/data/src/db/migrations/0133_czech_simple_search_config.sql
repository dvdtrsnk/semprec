CREATE TEXT SEARCH CONFIGURATION czech_simple (COPY = simple);
ALTER TEXT SEARCH CONFIGURATION czech_simple
  ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part
  WITH unaccent, simple;
