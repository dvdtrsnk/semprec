import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createHttpGenericOperations } from "./api/httpGenericOperations.js";
import { createAiUsageOperations } from "./api/aiUsageOperations.js";
import { createMcpAgentPageOperations } from "./api/mcpAgentPageOperations.js";
import { createApprovalQueueOperations } from "./api/approvalQueueOperations.js";

/**
 * Composition root: which backend to talk to and which view to open come from the
 * environment and the URL, never from a component. `?page=ai-usage` routes to the System
 * page's Utilization graph (issue #121), `?page=agent&project=<id>&database=<id>` routes to
 * a project's AGENT page (issue #127), and `?page=approvals&user=<id>` routes to the global
 * approval queue (issue #132) instead of an item/view id — none of these are choke-point
 * views, so they don't go through `?view=`. `user` is a stopgap stand-in for a real session
 * (there is no auth/current-user concept in the frontend yet — that's the auth-v1 epic).
 */
const params = new URLSearchParams(window.location.search);
const viewId = params.get("view") ?? "";
const page = params.get("page");
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "/api";
const operations = createHttpGenericOperations({ baseUrl: apiBaseUrl });
// No token here: the endpoint's stopgap bearer secret stays server-side (vite.config.ts's dev
// proxy attaches it), so this client only ever issues a plain same-origin fetch.
const aiUsageOperations = page === "ai-usage" ? createAiUsageOperations({ baseUrl: apiBaseUrl }) : undefined;
const agentPage =
  page === "agent" && params.get("project") && params.get("database")
    ? {
        projectItemId: params.get("project")!,
        databaseId: params.get("database")!,
        mcpOperations: createMcpAgentPageOperations({ baseUrl: apiBaseUrl }),
      }
    : undefined;
const approvalQueue =
  page === "approvals" && params.get("user")
    ? {
        operations: createApprovalQueueOperations({ baseUrl: apiBaseUrl }),
        decidedByUserId: params.get("user")!,
      }
    : undefined;

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root container");

createRoot(container).render(
  <StrictMode>
    <App
      viewId={viewId}
      operations={operations}
      aiUsageOperations={aiUsageOperations}
      agentPage={agentPage}
      approvalQueue={approvalQueue}
    />
  </StrictMode>,
);
