import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkModuleBoundaries } from "@semprec/module-boundaries";
import { ROUTE_MATRIX, type RouteMatrixEntry } from "../routeMatrix.js";

const backendRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/**
 * Maps every `surface: "api"` entry in `routeMatrix.ts` to the source file that actually owns
 * it, mirroring `app.ts`'s fixed dispatch table for built-in routes and the `customRoutes`
 * declared on the module manifests (#239) that `mountCustomRoutes` dispatches ahead of it. A
 * route added to `ROUTE_MATRIX` without a matching entry here fails the "every route is mapped"
 * test below — the mapping cannot silently drift out of date the way a route-count check could.
 */
const ROUTE_HANDLER_FILES: Record<string, string> = {
  login: "services/semprec-api/src/authHandler.ts",
  "password-reset request": "services/semprec-api/src/authHandler.ts",
  "password-reset consume": "services/semprec-api/src/authHandler.ts",
  logout: "services/semprec-api/src/authHandler.ts",
  "revoke session": "services/semprec-api/src/authHandler.ts",
  "current session": "services/semprec-api/src/authHandler.ts",
  "first-account setup (API)": "services/semprec-api/src/setupHandler.ts",
  "schema projection": "services/semprec-api/src/schemaHandler.ts",
  "approval queue": "services/semprec-api/src/approvalRequestsHandler.ts",
  "approval decision": "services/semprec-api/src/approvalRequestsHandler.ts",
  "agent run detail": "services/semprec-api/src/agentRunHandler.ts",
  "unread notifications": "services/semprec-api/src/notificationsHandler.ts",
  "visit notification": "services/semprec-api/src/notificationsHandler.ts",
  "mark all notifications read": "services/semprec-api/src/notificationsHandler.ts",
  "project mcp grants": "services/semprec-api/src/mcpAgentPageHandler.ts",
  "project mcp grant toggle": "services/semprec-api/src/mcpAgentPageHandler.ts",
  "mcp tool registration reclassify": "services/semprec-api/src/mcpAgentPageHandler.ts",
  "confirm proposal": "packages/data/src/inbox/inboxRouteHandlers.ts",
  "inbox types": "packages/data/src/inbox/inboxRouteHandlers.ts",
  "register push subscription": "packages/data/src/push/pushRouteHandlers.ts",
  "revoke push subscription": "packages/data/src/push/pushRouteHandlers.ts",
  "ai usage report": "packages/data/src/aiGateway/aiUsageRouteHandler.ts",
  "list databases": "services/semprec-api/src/databasesHandler.ts",
  "create database": "services/semprec-api/src/databasesHandler.ts",
  "database detail": "services/semprec-api/src/databasesHandler.ts",
  "rename database": "services/semprec-api/src/databasesHandler.ts",
  "archive database": "services/semprec-api/src/databasesHandler.ts",
  "create property": "services/semprec-api/src/databasesHandler.ts",
  "update property": "services/semprec-api/src/propertiesHandler.ts",
  "delete property": "services/semprec-api/src/propertiesHandler.ts",
  "create view": "services/semprec-api/src/viewsHandler.ts",
  "patch view": "services/semprec-api/src/viewsHandler.ts",
  "delete view": "services/semprec-api/src/viewsHandler.ts",
  "add/reposition curated view item": "services/semprec-api/src/viewsHandler.ts",
  "remove curated view item": "services/semprec-api/src/viewsHandler.ts",
  "create item": "services/semprec-api/src/itemsHandler.ts",
  "item detail": "services/semprec-api/src/itemsHandler.ts",
  "patch item": "services/semprec-api/src/itemsHandler.ts",
  "delete item": "services/semprec-api/src/itemsHandler.ts",
  "restore item": "services/semprec-api/src/itemsHandler.ts",
  "upload file": "services/semprec-api/src/filesHandler.ts",
  "download blob": "services/semprec-api/src/blobsHandler.ts",
};

const apiRoutes: RouteMatrixEntry[] = ROUTE_MATRIX.filter((route) => route.surface === "api");

/**
 * Issue #154: every route this service and the ModuleRegistry manifest it mounts (#239) register
 * is dispatched from `app.ts` into a handler under `src/`, which reaches `items`/`databases`/
 * `properties` only by calling into `@semprec/data`'s choke-point (`createChokePoint` and its
 * individually re-exported functions) — never by importing the write-capable stores that back it
 * directly. `dependency-cruiser.rules.json`'s `no-core-table-write-outside-choke-point` rule
 * (enforced fixture-level in `@semprec/module-boundaries`) makes that structurally impossible; this
 * test runs the same rule against the real adapter, choke-point, and module-registry source instead
 * of a fixture, so a handler that bypasses the choke-point fails here, not just in code review.
 */
describe("choke-point write boundary for route handlers (issue #154)", () => {
  it("maps every registered api route to the handler file that owns it", () => {
    for (const route of apiRoutes) {
      expect(ROUTE_HANDLER_FILES[route.name], `no handler mapping for route "${route.name}"`).toBeDefined();
    }
    expect(Object.keys(ROUTE_HANDLER_FILES).sort()).toEqual(apiRoutes.map((route) => route.name).sort());
  });

  it("keeps every handler reachable from this service's dispatcher free of direct core-table writes", async () => {
    const { violations, scannedFiles } = await checkModuleBoundaries(backendRoot, [
      "services/semprec-api",
      "packages/data",
      "packages/module-registry",
    ]);

    // Prove the scan actually reached each route's handler file before trusting its clean bill
    // of health — an unmapped or unreached handler would otherwise pass this test vacuously.
    for (const route of apiRoutes) {
      const handlerFile = ROUTE_HANDLER_FILES[route.name];
      expect(scannedFiles, `handler for route "${route.name}" (${handlerFile}) was not scanned`).toContain(handlerFile);
    }

    const writeBoundaryViolations = violations.filter((violation) =>
      violation.rules.includes("no-core-table-write-outside-choke-point"),
    );

    for (const route of apiRoutes) {
      const handlerFile = ROUTE_HANDLER_FILES[route.name];
      const routeViolations = writeBoundaryViolations.filter((violation) => violation.importer === handlerFile);
      expect(routeViolations, `route "${route.name}" (${handlerFile}) writes a core table directly`).toEqual([]);
    }

    expect(writeBoundaryViolations).toEqual([]);
  }, 30_000);

  it("does not itself flag the choke-point package's own writes to items/databases/properties", async () => {
    const { violations } = await checkModuleBoundaries(backendRoot, ["packages/data"]);
    const writeBoundaryViolations = violations.filter((violation) =>
      violation.rules.includes("no-core-table-write-outside-choke-point"),
    );

    expect(writeBoundaryViolations).toEqual([]);
  }, 30_000);
});
