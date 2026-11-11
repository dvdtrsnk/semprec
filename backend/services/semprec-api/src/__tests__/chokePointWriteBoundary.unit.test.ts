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
  "project guidance read": "packages/data/src/projectAgentGuidance/projectAgentGuidanceRouteHandlers.ts",
  "project guidance save": "packages/data/src/projectAgentGuidance/projectAgentGuidanceRouteHandlers.ts",
  "project guidance drift read": "packages/data/src/guidanceDrift/guidanceDriftFindingsRouteHandlers.ts",
  "guidance drift resolve": "packages/data/src/guidanceDrift/guidanceDriftFindingsRouteHandlers.ts",
  "semp thread detail": "services/semprec-api/src/sempThreadsHandler.ts",
  "semp thread create message": "services/semprec-api/src/sempThreadsHandler.ts",
  "semp thread send message": "services/semprec-api/src/sempThreadsHandler.ts",
  "semp thread messages": "services/semprec-api/src/sempThreadsHandler.ts",
  "semp thread list": "services/semprec-api/src/sempThreadsHandler.ts",
  "semp message speech": "services/semprec-api/src/sempSpeechHandler.ts",
  "server identity": "services/semprec-api/src/serverInfoHandler.ts",
  "shallow health check": "services/semprec-api/src/healthzHandler.ts",
  login: "services/semprec-api/src/authHandler.ts",
  "password-reset request": "services/semprec-api/src/authHandler.ts",
  "password-reset consume": "services/semprec-api/src/authHandler.ts",
  logout: "services/semprec-api/src/authHandler.ts",
  "list sessions": "services/semprec-api/src/authHandler.ts",
  "revoke session": "services/semprec-api/src/authHandler.ts",
  "revoke other sessions": "services/semprec-api/src/authHandler.ts",
  "set self person": "services/semprec-api/src/authHandler.ts",
  "current session": "services/semprec-api/src/authHandler.ts",
  "change password": "services/semprec-api/src/authHandler.ts",
  "first-account setup (API)": "services/semprec-api/src/setupHandler.ts",
  "accept invitation": "services/semprec-api/src/invitationHandler.ts",
  "schema projection": "services/semprec-api/src/schemaHandler.ts",
  "approval queue": "services/semprec-api/src/approvalRequestsHandler.ts",
  "approval decision": "services/semprec-api/src/approvalRequestsHandler.ts",
  "mcp json-rpc endpoint": "services/semprec-api/src/mcp/mcpHandler.ts",
  "agent run detail": "services/semprec-api/src/agentRunHandler.ts",
  "mint mcp run credential": "services/semprec-api/src/agentRunHandler.ts",
  "unread notifications": "services/semprec-api/src/notificationsHandler.ts",
  "resolved notifications": "services/semprec-api/src/notificationsHandler.ts",
  "visit notification": "services/semprec-api/src/notificationsHandler.ts",
  "mark all notifications read": "services/semprec-api/src/notificationsHandler.ts",
  "get notification preferences": "packages/data/src/notifications/notificationPreferencesRoutes.ts",
  "patch notification preferences": "packages/data/src/notifications/notificationPreferencesRoutes.ts",
  "trigger heartbeat": "packages/data/src/scheduler/triggerHeartbeatRoute.ts",
  "set heartbeat enabled": "packages/data/src/scheduler/setHeartbeatEnabledRoute.ts",
  "project mcp grants": "services/semprec-api/src/mcpAgentPageHandler.ts",
  "project mcp grant toggle": "services/semprec-api/src/mcpAgentPageHandler.ts",
  "mcp tool registration reclassify": "services/semprec-api/src/mcpAgentPageHandler.ts",
  "confirm proposal": "packages/data/src/inbox/inboxRouteHandlers.ts",
  "inbox types": "packages/data/src/inbox/inboxRouteHandlers.ts",
  "journal period read": "packages/data/src/journal/journalRouteHandlers.ts",
  "journal period ensure": "packages/data/src/journal/journalRouteHandlers.ts",
  "create transcription": "packages/data/src/transcription/transcriptionRouteHandlers.ts",
  "transcription rerun": "packages/data/src/transcription/transcriptionRouteHandlers.ts",
  "transcript list": "packages/data/src/transcription/transcriptionRouteHandlers.ts",
  "transcript delete": "packages/data/src/transcription/transcriptionRouteHandlers.ts",
  "transcript detail": "packages/data/src/transcription/transcriptionRouteHandlers.ts",
  "transcript speakers": "packages/data/src/transcription/transcriptionRouteHandlers.ts",
  "transcript summaries": "packages/data/src/transcription/transcriptionRouteHandlers.ts",
  "transcript action item state": "packages/data/src/transcription/transcriptionRouteHandlers.ts",
  "register push subscription": "packages/data/src/push/pushRouteHandlers.ts",
  "revoke push subscription": "packages/data/src/push/pushRouteHandlers.ts",
  "ai usage report": "packages/data/src/aiGateway/aiUsageRouteHandler.ts",
  "ai usage summary": "packages/data/src/aiGateway/aiUsageRouteHandler.ts",
  "system health report": "packages/data/src/observability/systemHealthRouteHandler.ts",
  "semp status": "packages/data/src/semp/sempStatusRouteHandler.ts",
  "semp status summary": "packages/data/src/semp/sempStatusRouteHandler.ts",
  "request account export": "services/semprec-api/src/accountHandler.ts",
  "list account exports": "services/semprec-api/src/accountHandler.ts",
  "download account export": "services/semprec-api/src/accountHandler.ts",
  "delete own account": "services/semprec-api/src/accountHandler.ts",
  "update profile": "services/semprec-api/src/accountHandler.ts",
  "admin account list": "services/semprec-api/src/adminHandler.ts",
  "admin operations health": "services/semprec-api/src/adminHandler.ts",
  "admin ai budgets": "services/semprec-api/src/adminHandler.ts",
  "admin set ai budget": "services/semprec-api/src/adminHandler.ts",
  "admin suspend account": "services/semprec-api/src/adminHandler.ts",
  "admin reactivate account": "services/semprec-api/src/adminHandler.ts",
  "admin delete account": "services/semprec-api/src/adminHandler.ts",
  "admin change account role": "services/semprec-api/src/adminHandler.ts",
  "admin create invite": "services/semprec-api/src/adminHandler.ts",
  "admin list invites": "services/semprec-api/src/adminHandler.ts",
  "admin revoke invite": "services/semprec-api/src/adminHandler.ts",
  "list databases": "services/semprec-api/src/databasesHandler.ts",
  "create database": "services/semprec-api/src/databasesHandler.ts",
  "database detail": "services/semprec-api/src/databasesHandler.ts",
  "rename database": "services/semprec-api/src/databasesHandler.ts",
  "archive database": "services/semprec-api/src/databasesHandler.ts",
  "restore database": "services/semprec-api/src/databasesHandler.ts",
  "property catalog": "services/semprec-api/src/databasesHandler.ts",
  "create property": "services/semprec-api/src/databasesHandler.ts",
  "property list": "services/semprec-api/src/propertiesHandler.ts",
  "property detail": "services/semprec-api/src/propertiesHandler.ts",
  "update property": "services/semprec-api/src/propertiesHandler.ts",
  "delete property": "services/semprec-api/src/propertiesHandler.ts",
  "list views": "services/semprec-api/src/viewsHandler.ts",
  "view detail": "services/semprec-api/src/viewsHandler.ts",
  "create view": "services/semprec-api/src/viewsHandler.ts",
  "patch view": "services/semprec-api/src/viewsHandler.ts",
  "delete view": "services/semprec-api/src/viewsHandler.ts",
  "add/reposition curated view item": "services/semprec-api/src/viewsHandler.ts",
  "reorder curated view item": "services/semprec-api/src/viewsHandler.ts",
  "remove curated view item": "services/semprec-api/src/viewsHandler.ts",
  "create item": "services/semprec-api/src/itemsHandler.ts",
  "item detail": "services/semprec-api/src/itemsHandler.ts",
  "patch item": "services/semprec-api/src/itemsHandler.ts",
  "delete item": "services/semprec-api/src/itemsHandler.ts",
  "restore item": "services/semprec-api/src/itemsHandler.ts",
  "query database": "services/semprec-api/src/itemsHandler.ts",
  "unlink value": "services/semprec-api/src/itemsHandler.ts",
  "relink value": "services/semprec-api/src/itemsHandler.ts",
  "set relation": "services/semprec-api/src/itemsHandler.ts",
  "create/replace relation": "services/semprec-api/src/itemsHandler.ts",
  "delete relation": "services/semprec-api/src/itemsHandler.ts",
  "list relations": "services/semprec-api/src/itemsHandler.ts",
  "ensure page": "services/semprec-api/src/itemsHandler.ts",
  "get page": "services/semprec-api/src/itemsHandler.ts",
  "read page markdown": "services/semprec-api/src/pageMarkdownHandler.ts",
  "insert page markdown": "services/semprec-api/src/pageMarkdownHandler.ts",
  "list page changes": "services/semprec-api/src/pageChangesHandler.ts",
  "create subpage": "services/semprec-api/src/itemsHandler.ts",
  "restore page version": "services/semprec-api/src/itemsHandler.ts",
  "count items": "services/semprec-api/src/itemsHandler.ts",
  "duplicate page": "services/semprec-api/src/itemsHandler.ts",
  "rename page": "services/semprec-api/src/itemsHandler.ts",
  "query view": "services/semprec-api/src/viewsHandler.ts",
  "recording upload": "services/semprec-api/src/recordingsHandler.ts",
  "upload file": "services/semprec-api/src/filesHandler.ts",
  "upload blob": "services/semprec-api/src/blobUploadHandler.ts",
  "download blob": "services/semprec-api/src/blobsHandler.ts",
  "mail autonomous send projects": "packages/data/src/mail/mailAutonomousSendRouteHandlers.ts",
  "mail contacts": "packages/data/src/mail/mailContactsRoute.ts",
  "mail threads": "packages/data/src/mail/mailThreadRoutes.ts",
  "mail thread detail": "packages/data/src/mail/mailThreadRoutes.ts",
  "mailbox list": "packages/data/src/mail/mailboxRouteHandlers.ts",
  "mailbox detail": "packages/data/src/mail/mailboxRouteHandlers.ts",
  "mailbox password connect": "packages/data/src/mail/mailboxPasswordRouteHandlers.ts",
  "mailbox removal impact": "packages/data/src/mail/mailboxRemovalImpact.ts",
  "mailbox removal": "packages/data/src/mail/mailboxRemoval.ts",
  "Microsoft Graph mail webhook": "services/semprec-api/src/graphWebhookHandler.ts",
  "mail oauth start": "packages/data/src/mail/mailOauthRouteHandlers.ts",
  "mail oauth complete": "packages/data/src/mail/mailOauthRouteHandlers.ts",
  "mail oauth callback": "services/semprec-api/src/mailOauthCallbackHandler.ts",
  "mail summary": "packages/data/src/mail/mailSummary.ts",
  "mailbox folder list": "packages/data/src/mail/mailFolderList.ts",
  "mailbox reauthorize": "packages/data/src/mail/mailOauthRouteHandlers.ts",
  "mail thread facets": "packages/data/src/mail/mailThreadRoutes.ts",
  "task recurrence set": "packages/data/src/tasks/taskRecurrenceRoutes.ts",
  "task series edit": "packages/data/src/tasks/taskSeriesRoutes.ts",
  "task recurrence clear": "packages/data/src/tasks/taskRecurrenceRoutes.ts",
  "calendar timeline": "packages/data/src/calendar/timelineRouteHandler.ts",
  "task occurrence materialize": "packages/data/src/tasks/taskOccurrenceRoutes.ts",
  "task host event put": "packages/data/src/tasks/taskHostEventRouteHandlers.ts",
  "task host event remove": "packages/data/src/tasks/taskHostEventRouteHandlers.ts",
  "task host events clear": "packages/data/src/tasks/taskHostEventRouteHandlers.ts",
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
  }, 90_000);

  it("does not itself flag the choke-point package's own writes to items/databases/properties", async () => {
    const { violations } = await checkModuleBoundaries(backendRoot, ["packages/data"]);
    const writeBoundaryViolations = violations.filter((violation) =>
      violation.rules.includes("no-core-table-write-outside-choke-point"),
    );

    expect(writeBoundaryViolations).toEqual([]);
  }, 90_000);
});
