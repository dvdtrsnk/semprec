import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import type { PasswordResetMailer, loadFullModuleRegistry } from "@semprec/data";
import { createAiUsageRequestListener } from "./aiUsageHandler.js";
import { createMcpAgentPageRequestListener } from "./mcpAgentPageHandler.js";
import { createApprovalRequestsRequestListener } from "./approvalRequestsHandler.js";
import { createAgentRunRequestListener } from "./agentRunHandler.js";
import { createAuthRequestListener } from "./authHandler.js";
import { createPushSubscriptionsRequestListener } from "./pushSubscriptionsHandler.js";
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
 * Routes by path prefix; `mcpAgentPageListener` already answers 404 itself for anything else.
 */
export function createDispatcher(pool: Pool, options: AppOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const aiUsageListener = createAiUsageRequestListener(pool);
  const mcpAgentPageListener = createMcpAgentPageRequestListener(pool);
  const approvalRequestsListener = createApprovalRequestsRequestListener(pool);
  const agentRunListener = createAgentRunRequestListener(pool);
  const authListener = createAuthRequestListener(pool, {
    passwordResetMailer: options.passwordResetMailer,
    appBaseUrl: options.appBaseUrl,
  });
  const pushSubscriptionsListener = createPushSubscriptionsRequestListener(pool);
  const notificationsListener = createNotificationsRequestListener(pool);
  const setupListener = createSetupRequestListener(pool, { setupToken: options.setupToken });
  const schemaListener = createSchemaRequestListener(pool, options.moduleRegistry);

  return function dispatch(req: IncomingMessage, res: ServerResponse): void {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/api/schema") {
      void schemaListener(req, res);
      return;
    }
    if (pathname === "/api/ai-usage") {
      void aiUsageListener(req, res);
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
    if (pathname.startsWith("/api/push-subscriptions")) {
      void pushSubscriptionsListener(req, res);
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
