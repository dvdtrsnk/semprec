import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import type { PasswordResetMailer, loadFullModuleRegistry } from "@semprec/data";
import { mountCustomRoutes } from "./adapter/customRouteMount.js";
import { mountRoutes } from "./adapter/routeTable.js";
import { createDatabaseRoutes } from "./databasesHandler.js";
import { createItemRoutes } from "./itemsHandler.js";
import { createPropertyRoutes } from "./propertiesHandler.js";
import { createViewRoutes } from "./viewsHandler.js";
import { createMcpAgentPageRequestListener } from "./mcpAgentPageHandler.js";
import { createApprovalRequestsRequestListener } from "./approvalRequestsHandler.js";
import { createAgentRunRequestListener } from "./agentRunHandler.js";
import { createAuthRequestListener } from "./authHandler.js";
import { createNotificationsRequestListener } from "./notificationsHandler.js";
import { createSetupRequestListener } from "./setupHandler.js";
import { createSchemaRequestListener } from "./schemaHandler.js";

export interface AppOptions {
  passwordResetMailer: PasswordResetMailer;
  appBaseUrl: string;
  setupToken: string;
  /** Backs `GET /api/schema` (issue #147) — every active module's manifest loaded once at startup. */
  moduleRegistry: Awaited<ReturnType<typeof loadFullModuleRegistry>>;
}

/**
 * The full request dispatcher: `serve.ts` calls this to get the listener it hands to
 * `http.createServer`, and `__tests__/routeMatrix.test.ts` (issue #143) calls it the same way to
 * drive `routeMatrix.ts`'s inventory against a real in-memory server, with no process/port of
 * its own to manage.
 *
 * Routes by path prefix; a module's custom route (issue #239 — `POST /api/proposals/:id/confirm`,
 * `GET /api/inbox-types`, `POST /api/push-subscriptions`, `POST /api/push-subscriptions/:id/revoke`,
 * `GET /api/ai-usage`) is tried first through `mountCustomRoutes`, then the generic database/property/
 * view/item resource routes (issue #240 — `/api/databases`, `/api/properties/:id`; issue #155 —
 * `/api/views/:id`, `/api/views/:id/items/:itemId`; issue #241 — `/api/databases/:id/items`,
 * `/api/items/:id`) through `mountRoutes`, since
 * none of those paths are exact prefixes this function otherwise routes; `mcpAgentPageListener` still
 * answers 404 itself for anything left unmatched.
 */
export async function createDispatcher(
  pool: Pool,
  options: AppOptions,
): Promise<(req: IncomingMessage, res: ServerResponse) => void> {
  const customRouteDefinitions = await options.moduleRegistry.getCustomRouteDefinitions();
  const dispatchCustomRoute = mountCustomRoutes(pool, customRouteDefinitions);
  const dispatchResourceRoute = mountRoutes(pool, [
    ...createDatabaseRoutes(pool, options.moduleRegistry),
    ...createPropertyRoutes(pool, options.moduleRegistry),
    ...createViewRoutes(pool),
    ...createItemRoutes(pool),
  ]);
  const mcpAgentPageListener = createMcpAgentPageRequestListener(pool);
  const approvalRequestsListener = createApprovalRequestsRequestListener(pool);
  const agentRunListener = createAgentRunRequestListener(pool);
  const authListener = createAuthRequestListener(pool, {
    passwordResetMailer: options.passwordResetMailer,
    appBaseUrl: options.appBaseUrl,
  });
  const notificationsListener = createNotificationsRequestListener(pool);
  const setupListener = createSetupRequestListener(pool, { setupToken: options.setupToken });
  const schemaListener = createSchemaRequestListener(pool, options.moduleRegistry);

  return function dispatch(req: IncomingMessage, res: ServerResponse): void {
    if (dispatchCustomRoute(req, res)) return;
    if (dispatchResourceRoute(req, res)) return;

    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/api/schema") {
      void schemaListener(req, res);
      return;
    }
    if (pathname === "/api/approval-requests" || pathname.startsWith("/api/approval-requests/")) {
      void approvalRequestsListener(req, res);
      return;
    }
    if (pathname.startsWith("/api/agent-runs/")) {
      void agentRunListener(req, res);
      return;
    }
    if (pathname.startsWith("/api/auth/")) {
      void authListener(req, res);
      return;
    }
    if (pathname.startsWith("/api/notifications")) {
      void notificationsListener(req, res);
      return;
    }
    if (pathname === "/api/setup") {
      void setupListener(req, res);
      return;
    }
    void mcpAgentPageListener(req, res);
  };
}
