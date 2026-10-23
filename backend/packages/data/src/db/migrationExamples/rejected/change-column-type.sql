-- Narrowing: the previous release writes titles longer than 10 characters.
ALTER TABLE notes ALTER COLUMN title TYPE varchar(10);
