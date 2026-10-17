import type { Pool } from "pg";
import { listAccounts } from "@semprec/data";
import type { RouteDefinition } from "./adapter/routeTable.js";
import type { AppOptions } from "./app.js";

/**
 * The admin route family (issue #1037). Every route is flagged `admin: true`, so the adapter
 * refuses members with 403 `admin_required` and runs the handler in system scope; handlers here
 * read global identity tables only and never enter a tenant
 * (docs/adr/2026-10-17-admin-role-without-content-access.md). `_options` is the dispatcher's own
 * options object, passed through for the admin routes later issues add.
 */
export function createAdminRoutes(pool: Pool, _options: AppOptions): RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/api/admin/accounts",
      admin: true,
      handler: async () => ({ status: 200, body: { accounts: await listAccounts(pool) } }),
    },
  ];
}
