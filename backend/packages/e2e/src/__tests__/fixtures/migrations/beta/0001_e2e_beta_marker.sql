-- Fixture structural migration for the "e2e-beta" module (module-contract issue #114); see
-- migrations/alpha/0001_e2e_alpha_marker.sql for why this exists.
CREATE TABLE IF NOT EXISTS e2e_beta_marker (
  id int PRIMARY KEY
);
