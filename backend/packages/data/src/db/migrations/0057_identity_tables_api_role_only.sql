-- Issue #976: restrict DML on the identity tables to semprec_data.
--
-- The identity plane (users, sessions, password_reset_tokens, login_attempts, tenants) decides who a
-- request is and which tenant it belongs to. It is written only by the API process (semprec-api, which
-- connects as semprec_data). A compromise of the side role must not be able to mint sessions, rebind a
-- user to another tenant, change a role or flip a tenant's status, so semprec_side keeps SELECT only
-- (the restore-test recorder and app_sole_tenant() need it).
--
-- Backward compatible: the previous release's API already runs as semprec_data, which now holds the
-- grant directly rather than through its membership in semprec_side, and no side-role process writes
-- these tables, so that release keeps working against this schema after a rollback.

GRANT SELECT, INSERT, UPDATE, DELETE ON users, sessions, password_reset_tokens, login_attempts, tenants TO semprec_data;
REVOKE INSERT, UPDATE, DELETE ON users, sessions, password_reset_tokens, login_attempts, tenants FROM semprec_side;
