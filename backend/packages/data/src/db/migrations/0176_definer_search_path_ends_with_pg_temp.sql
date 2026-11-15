-- Finding R2-DB-1 of gh-1086 (external review): the SECURITY DEFINER functions pin
-- `search_path = pg_catalog, public` without naming pg_temp.
--
-- When pg_temp is not listed, PostgreSQL searches the session's temporary schema FIRST for relation
-- and type names. A runtime role can create objects there (PUBLIC holds TEMPORARY on the database
-- by default), so a session of semprec_data that creates a domain `pg_temp.text` whose check calls a
-- function it also created in pg_temp makes the unqualified type names in the bodies of
-- create_items_partition(uuid) and drop_items_partition(uuid) resolve to that domain. The check then
-- runs as the function's owner, the migrating superuser. Listing pg_temp LAST makes the lookup try
-- pg_catalog and public before the temporary schema, so a name that exists in either is never
-- shadowed. The five router functions owned by semprec_router (BYPASSRLS) get the same setting as
-- defence in depth.
--
-- ALTER FUNCTION ... SET search_path changes only proconfig: no function body, owner, grant or
-- signature changes. The previous release calls these functions the same way, so a rollback of the
-- release finds the schema it expects.

ALTER FUNCTION create_items_partition(uuid) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION drop_items_partition(uuid) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION route_graph_subscription(text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION route_gmail_address(text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION ai_global_spend() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION ops_health_counts() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION ai_tenant_spend() SET search_path = pg_catalog, public, pg_temp;
