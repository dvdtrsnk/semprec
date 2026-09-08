import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createTransport } from "nodemailer";
import {
  createPool,
  NodemailerPasswordResetMailer,
  noopPasswordResetMailer,
  type PasswordResetMailer,
} from "@semprec/data";
import { createAiUsageRequestListener } from "./aiUsageHandler.js";
import { createMcpAgentPageRequestListener } from "./mcpAgentPageHandler.js";
import { createApprovalRequestsRequestListener } from "./approvalRequestsHandler.js";
import { createAgentRunRequestListener } from "./agentRunHandler.js";
import { createAuthRequestListener } from "./authHandler.js";
import { createSetupRequestListener } from "./setupHandler.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const authToken = process.env.SEMPREC_API_TOKEN;
if (!authToken) throw new Error("SEMPREC_API_TOKEN is not set");

// One-time bootstrap secret for `POST /api/setup` (#233): a shared secret file, provisioned by
// the operations batch this issue's Task calls out of scope, whose contents this process reads
// into `SETUP_TOKEN`. Required at startup like `SEMPREC_API_TOKEN` above — there is no
// supported way to run this service without a value, since the setup route's entire safety
// rests on comparing the caller's token against this one.
const setupToken = process.env.SETUP_TOKEN;
if (!setupToken) throw new Error("SETUP_TOKEN is not set");

const rawPort = process.env.PORT ?? "3001";
const port = Number(rawPort);
if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT is not a valid port number: ${rawPort}`);

// `APP_BASE_URL` and `SMTP_*` back issue #142's password-reset emails. Both are optional at
// startup — a deployment that hasn't configured outbound SMTP yet still boots, and only the
// password-reset request route fails (via `noopPasswordResetMailer`) if it's ever hit.
const appBaseUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";

function buildPasswordResetMailer(): PasswordResetMailer {
  const host = process.env.SMTP_HOST;
  const from = process.env.SMTP_FROM_ADDRESS;
  if (!host || !from) return noopPasswordResetMailer;

  const transporter = createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? "587"),
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
  });
  return new NodemailerPasswordResetMailer(transporter, from);
}

const pool = createPool(connectionString);
const aiUsageListener = createAiUsageRequestListener(pool, { authToken });
const mcpAgentPageListener = createMcpAgentPageRequestListener(pool, { authToken });
const approvalRequestsListener = createApprovalRequestsRequestListener(pool, { authToken });
const agentRunListener = createAgentRunRequestListener(pool, { authToken });
const authListener = createAuthRequestListener(pool, { passwordResetMailer: buildPasswordResetMailer(), appBaseUrl });
const setupListener = createSetupRequestListener(pool, { setupToken });

/** Routes by path prefix; `mcpAgentPageListener` already answers 404 itself for anything else. */
function dispatch(req: IncomingMessage, res: ServerResponse): void {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
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
  if (pathname === "/api/setup") {
    void setupListener(req, res);
    return;
  }
  void mcpAgentPageListener(req, res);
}

const server = createServer(dispatch);

server.listen(port, () => {
  console.log(`semprec-api listening on port ${port}`);
});
