import { createServer } from "node:http";
import {
  createPool,
  LocalFsBlobStorageWriter,
  loadFullModuleRegistry,
  NodemailerPasswordResetMailer,
  noopPasswordResetMailer,
  resolveDocHistoryRetentionDays,
  startProcessHeartbeat,
  type PasswordResetMailer,
} from "@semprec/data";
import { createTransport } from "nodemailer";
import { wireRealtimeHooks } from "@semprec/realtime";
import { installFatalHandlers, withTraceContext } from "@semprec/shared";
import { createDispatcher } from "./app.js";
import { createSyncUpgradeHandler } from "./syncHandler.js";
import { createApiQueueRuntime } from "./queueRuntime.js";
import { createGracefulShutdown, registerShutdownSignals } from "./shutdown.js";
import { logger } from "./logger.js";

// Installed before anything else runs: an uncaught exception or unhandled rejection during
// startup (the env-var checks below, pool creation, module-registry load) must still log
// fatally and exit non-zero rather than crash silently or hang.
installFatalHandlers(logger);

// SEMPREC_API_DATABASE_URL is this process's own key in the single shared `/opt/semprec/shared/.env`
// (issue #175) — semprec-api is the only process authenticating as the `semprec_data` role (see
// docs/operations/database-roles.md), so it cannot share one `DATABASE_URL` name with the
// `semprec_side` processes that read the same file. `DATABASE_URL` remains the fallback for local
// development, where a developer runs this service alone against its own per-service `.env`.
const connectionString = process.env.SEMPREC_API_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error("SEMPREC_API_DATABASE_URL (or DATABASE_URL) is not set");

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

// Issue #158: `POST /api/files`'s hard streamed-upload cap, and where `LocalFsBlobStorageWriter`
// keeps uploaded bytes on disk — same env-var shape as `MAIL_ATTACHMENTS_DIR` (worker.ts).
const maxFileSizeMb = Number(process.env.MAX_FILE_SIZE_MB ?? "100");
if (!Number.isFinite(maxFileSizeMb) || maxFileSizeMb <= 0) {
  throw new Error(`MAX_FILE_SIZE_MB is not a valid positive number: ${process.env.MAX_FILE_SIZE_MB}`);
}
const blobStorage = new LocalFsBlobStorageWriter(process.env.FILES_STORAGE_DIR ?? "/tmp/semprec-files");

const pool = createPool(connectionString);
wireRealtimeHooks(pool);

// Issue #168: this process's own `process_heartbeats` row, re-UPSERTed every 15 seconds for as
// long as this process is up — `GET /healthz` (and any future observability surface) reads it
// back through `process_heartbeats`, never through this in-memory handle.
startProcessHeartbeat(
  pool,
  { process: "api", pid: process.pid, version: process.env.APP_VERSION ?? "0.0.0" },
  { onError: (err) => logger.error({ err }, "Failed to record this process's heartbeat") },
);

const moduleRegistry = await loadFullModuleRegistry();
const dispatch = await createDispatcher(pool, {
  passwordResetMailer: buildPasswordResetMailer(),
  appBaseUrl,
  setupToken,
  moduleRegistry,
  blobStorage,
  maxFileSizeBytes: maxFileSizeMb * 1024 * 1024,
});
const syncServer = await createSyncUpgradeHandler(pool);

// Issue #91: this process is one of the queue's two composition roots — the one that installs
// `CORE_CRONTAB` and hosts every `queueAffinity: 'api'` task handler, over this same pool.
const queueRuntime = await createApiQueueRuntime(pool, moduleRegistry);

const server = createServer(dispatch);

const shutdown = createGracefulShutdown({ server, queueRuntime, pool, logger });
registerShutdownSignals(shutdown);

// `WS /api/sync` (issue #160) is the one WS upgrade route this service serves; anything else
// requesting a protocol upgrade gets its socket destroyed rather than silently ignored.
server.on("upgrade", (req, socket, head) => {
  withTraceContext({}, () => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/api/sync") {
      syncServer.handleUpgrade(req, socket, head);
      return;
    }
    socket.destroy();
  });
});

// Issue #174: bound to loopback explicitly — the only public entry point is the Caddy reverse
// proxy on the same host (`deploy/Caddyfile`), never this process's own listener directly.
server.listen(port, "127.0.0.1", () => {
  logger.info({ port }, "semprec-api listening");
});
