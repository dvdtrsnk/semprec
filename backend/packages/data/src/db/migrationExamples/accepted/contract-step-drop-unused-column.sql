-- expand-contract-exemption: contract step. legacy_color has not been read or written since the
-- release before the previous one, so neither the running release nor a rollback target uses it.
ALTER TABLE notes DROP COLUMN legacy_color;
