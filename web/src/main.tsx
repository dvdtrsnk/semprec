import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createHttpGenericOperations } from "./api/httpGenericOperations.js";
import { createAiUsageOperations } from "./api/aiUsageOperations.js";
import { createSystemHealthOperations } from "./api/systemHealthOperations.js";
import { createMcpAgentPageOperations } from "./api/mcpAgentPageOperations.js";
import { createApprovalQueueOperations } from "./api/approvalQueueOperations.js";
import { createAgentRunOperations } from "./api/agentRunOperations.js";
import { createSetupOperations } from "./api/setupOperations.js";
import { createAuthOperations } from "./api/authOperations.js";
import { createSessionFetch } from "./api/sessionFetch.js";
import { createAdminOperations } from "./api/adminOperations.js";
import { createAccountOperations } from "./api/accountOperations.js";

/**
 * Composition root: which backend to talk to and which view to open come from the
 * environment and the URL, never from a component. `?page=ai-usage` routes to the System
 * page's Utilization graph (issue #121), `?page=agent&project=<id>&database=<id>` routes to
 * a project's AGENT page (issue #127), `?page=approvals` routes to the global approval queue
 * (issue #132; a `user` query parameter from older backend-generated links is ignored), and
 * `?page=agent-run&id=<id>` routes to a single agent run's detail (issue #132's source
 * agent-run link) instead of an item/view id — none of these are choke-point views, so they
 * don't go through `?view=`. The session itself is bootstrapped by `App` from
 * `GET /api/auth/session`, which shows the login page (`?page=login` routes there directly)
 * until the session cookie exists, and drops back to it whenever an adapter's fetch receives
 * a 401.
 * `?page=setup&token=<setupToken>` routes to the first-account setup wizard (issue #234).
 * `?page=password-reset#token=<resetToken>` routes to the password-reset page (issue #1076); the
 * token travels in the fragment, which the browser never sends to the server, and the page clears it
 * from the address bar on mount. `?page=password-reset` without a fragment routes to the request form.
 * `?page=admin` routes to the admin page (issue #1079); the page itself is shown only to an admin
 * session, and a member sees a notice instead.
 * `?page=account` routes to the caller's own account page (issue #1083): the data export and
 * self-deletion. Every authenticated session may open it.
 */
const params = new URLSearchParams(window.location.search);
const viewId = params.get("view") ?? "";
const page = params.get("page");
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "/api";
const sessionEvents = new EventTarget();
// Every session-bound adapter shares this fetch, so a 401 anywhere drops the app back to login.
// Auth and setup keep the plain `fetch`: a failed login's 401 must not bounce the app, and setup
// runs before any session exists.
const fetchImpl = createSessionFetch(() => sessionEvents.dispatchEvent(new Event("unauthorized")));
const auth = createAuthOperations({ baseUrl: apiBaseUrl });
const operations = createHttpGenericOperations({ baseUrl: apiBaseUrl, fetchImpl });
const aiUsageOperations = page === "ai-usage" ? createAiUsageOperations({ baseUrl: apiBaseUrl, fetchImpl }) : undefined;
// Rendered beside the AI usage block on the same System page (issue #170), not behind its own `?page=`.
const systemHealthOperations =
  page === "ai-usage" ? createSystemHealthOperations({ baseUrl: apiBaseUrl, fetchImpl }) : undefined;
const agentPage =
  page === "agent" && params.get("project") && params.get("database")
    ? {
        projectItemId: params.get("project")!,
        databaseId: params.get("database")!,
        mcpOperations: createMcpAgentPageOperations({ baseUrl: apiBaseUrl, fetchImpl }),
      }
    : undefined;
const approvalQueue =
  page === "approvals" ? { operations: createApprovalQueueOperations({ baseUrl: apiBaseUrl, fetchImpl }) } : undefined;
const agentRun =
  page === "agent-run" && params.get("id")
    ? {
        agentRunId: params.get("id")!,
        operations: createAgentRunOperations({ baseUrl: apiBaseUrl, fetchImpl }),
      }
    : undefined;
const admin = page === "admin" ? { operations: createAdminOperations({ baseUrl: apiBaseUrl, fetchImpl }) } : undefined;
const account =
  page === "account" ? { operations: createAccountOperations({ baseUrl: apiBaseUrl, fetchImpl }) } : undefined;
const setup =
  page === "setup" && params.get("token")
    ? {
        token: params.get("token")!,
        operations: createSetupOperations({ baseUrl: apiBaseUrl }),
      }
    : undefined;

// An empty `#token=` is no token at all, so it falls back to the request form.
const passwordReset =
  page === "password-reset"
    ? { token: new URLSearchParams(window.location.hash.slice(1)).get("token") || null }
    : undefined;

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root container");

createRoot(container).render(
  <StrictMode>
    <App
      viewId={viewId}
      operations={operations}
      aiUsageOperations={aiUsageOperations}
      systemHealthOperations={systemHealthOperations}
      agentPage={agentPage}
      approvalQueue={approvalQueue}
      agentRun={agentRun}
      setup={setup}
      passwordReset={passwordReset}
      admin={admin}
      account={account}
      auth={auth}
      sessionEvents={sessionEvents}
      login={page === "login" ? true : undefined}
    />
  </StrictMode>,
);
