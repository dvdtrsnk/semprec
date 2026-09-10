import { createServer } from "node:http";
import { createTransport } from "nodemailer";
import {
  createPool,
  loadFullModuleRegistry,
  NodemailerPasswordResetMailer,
  noopPasswordResetMailer,
  resolveDocHistoryRetentionDays,
  type PasswordResetMailer,
} from "@semprec/data";
import { createDispatcher } from "./app.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

// Issue #216: DOC_HISTORY_RETENTION_DAYS must be a positive integer when set. Called eagerly
// here (its result discarded — request-time call sites re-read the same env var themselves)
// so a misconfigured value fails startup instead of being discovered lazily on the first doc
// read/write.
resolveDocHistoryRetentionDays();

// One-time bootstrap secret for `POST /api/setup` (#233): a shared secret file, provisioned by
// the operations batch this issue's Task calls out of scope, whose contents this process reads
// into `SETUP_TOKEN`. Required at startup — there is no supported way to run this service
// without a value, since the setup route's entire safety rests on comparing the caller's token
// against this one.
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
const moduleRegistry = await loadFullModuleRegistry();
const dispatch = createDispatcher(pool, {
  passwordResetMailer: buildPasswordResetMailer(),
  appBaseUrl,
  setupToken,
  moduleRegistry,
});

const server = createServer(dispatch);

server.listen(port, () => {
  console.log(`semprec-api listening on port ${port}`);
});
