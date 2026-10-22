-- Issue #1087, multi-tenant go-live: drops the single-tenant guard 0056 created, so accepting an
-- invitation can create a second tenant (docs/adr/2026-10-03-tenant-isolation-through-row-level-security.md).
--
-- A relaxation: it removes a constraint and changes no shape the previous release reads or writes.
-- The previous release is the strict one the go-live security gate (#1086) signed off: it sets a
-- tenant scope on every path and app_tenant_default() no longer falls back to the sole tenant
-- (#1067), so after a one-release rollback it keeps working against several tenants. That release
-- has no route that creates a tenant, so no further tenant appears while it runs.
DROP INDEX tenants_single_tenant_guard;
