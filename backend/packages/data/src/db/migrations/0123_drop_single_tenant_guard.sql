-- Issue #1087: drops the single-tenant guard so a second tenant can exist. Accepting an invitation
-- (backend/packages/data/src/tenancy/acceptInvitation.ts) creates one, and the Task of #1087 calls
-- for this relaxation explicitly.
--
-- A relaxation whose previous release is strict: that release relies on this index to make a second
-- `tenants` row impossible. Rolling back to it after a second tenant exists is not safe, because
-- app_sole_tenant() yields a tenant only while exactly one exists, so unscoped code of that release
-- fails closed. The second tenant is not to be deployed before the multi-tenant security gate (#1086)
-- is signed; this migration does not lift that gate.
DROP INDEX tenants_single_tenant_guard;
