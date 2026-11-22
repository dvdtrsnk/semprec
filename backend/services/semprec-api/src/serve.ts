import { createServer } from "node:http";
import {
  assertRuntimeRole,
  bindMailboxServiceLiveSyncStop,
  createMailLiveSyncRoot,
  createPool,
  LocalFsBlobStorageWriter,
  loadFullModuleRegistry,
  readMaxFileSizeBytes,
  resolveBlobStorageDir,
  NodemailerInviteMailer,
  NodemailerPasswordResetMailer,
  noopPasswordResetMailer,
  resolveDocHistoryRetentionDays,
  resolveModuleRuleKinds,
  startProcessHeartbeat,
  startTenantDeactivationListener,
  verifyCalDavServer,
  verifyMailCredentials,
  type InviteMailer,
  type PasswordResetMailer,
} from "@semprec/data";
import { createTransport, type Transporter } from "nodemailer";
import { wireRealtimeHooks } from "@semprec/realtime";
import { installFatalHandlers, withTraceContext } from "@semprec/shared";
import { createDispatcher } from "./app.js";
import type { CustomRouteDependencies, CustomRouteOAuthClient } from "./adapter/customRouteMount.js";
import { createMailLiveSyncControl } from "./mailLiveSyncControl.js";
import { createAiGatewayClientForApi } from "./projectAgentGuidanceComposition.js";
import {
  createGmailPubSubDispatcherFor,
  createImapIdleLifecycleFactory,
  createMailLiveSyncLifecycleFactory,
  resolveGmailWatchHosting,
  resolveGraphSubscriptionHosting,
} from "./mailLiveSyncLifecycles.js";
import { readOAuthClient } from "./mailSyncAdapters.js";
import { createVoiceChannel } from "./voiceChannel.js";
import { createVoiceSessionHandler } from "./voiceSessionHandler.js";
import { createSyncUpgradeHandler } from "./syncHandler.js";
import { createApiQueueRuntime } from "./queueRuntime.js";
import { createGracefulShutdown, registerShutdownSignals } from "./shutdown.js";
import { logger } from "./logger.js";

// Installed first, so a startup failure still logs fatally and exits non-zero rather than crash
// silently or hang.
installFatalHandlers(logger);

// semprec-api is the only process authenticating as `semprec_data`, so it has its own key in the
// shared `.env` rather than the `DATABASE_URL` the `semprec_side` processes read. `DATABASE_URL` is
// the fallback for local development.
const connectionString = process.env.SEMPREC_API_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error("SEMPREC_API_DATABASE_URL (or DATABASE_URL) is not set");

// Called eagerly (result discarded) so a misconfigured value fails startup instead of the first doc
// read/write.
resolveDocHistoryRetentionDays();

// One-time bootstrap secret for `POST /api/setup`. Required at startup: the setup route's safety
// rests entirely on comparing the caller's token with it.
const setupToken = process.env.SETUP_TOKEN;
if (!setupToken) throw new Error("SETUP_TOKEN is not set");

const rawPort = process.env.PORT ?? "3001";
const port = Number(rawPort);
if (!Number.isInteger(port) || port <= 0 || port > 65535)
  throw new Error(`PORT is not a valid port number: ${rawPort}`);

// Optional at startup: without SMTP the service boots and only the password-reset request route
// fails.
const appBaseUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";

/**
 * Same keys and rules as `createMailSyncAdapters`. An unset or empty key leaves the client out, so
 * a route needing it fails when it runs, not at startup.
 */
function optionalOAuthClient(idKey: string, secretKey: string): CustomRouteOAuthClient | undefined {
  const client = readOAuthClient(process.env, idKey, secretKey);
  return "missingEnv" in client ? undefined : client;
}

// The live-sync root is created after the dispatcher and bound to this control there.
const mailLiveSyncControl = createMailLiveSyncControl();

const customRouteDependencies: CustomRouteDependencies = {
  // The password routes verify a login, and the connect lists the account's folders, only through these members.
  mailServerClients: {
    verifyPassword: verifyMailCredentials,
    verifyCalDav: verifyCalDavServer,
  },
  oauth: {
    gmail: optionalOAuthClient("GMAIL_OAUTH_CLIENT_ID", "GMAIL_OAUTH_CLIENT_SECRET"),
    msGraph: optionalOAuthClient("MS_GRAPH_OAUTH_CLIENT_ID", "MS_GRAPH_OAUTH_CLIENT_SECRET"),
    redirectBaseUrl: appBaseUrl,
  },
  mailLiveSync: mailLiveSyncControl.control,
  // The thread task route names an unnamed task only through the gateway.
  aiGateway: createAiGatewayClientForApi(),
};

/**
 * `null` when SMTP is not configured. A set `SMTP_HOST` with an invalid `SMTP_PORT` throws at
 * startup.
 */
function buildSmtpTransport(): { transporter: Transporter; from: string } | null {
  const host = process.env.SMTP_HOST;
  const from = process.env.SMTP_FROM_ADDRESS;
  if (!host || !from) return null;

  const rawSmtpPort = process.env.SMTP_PORT ?? "587";
  const smtpPort = Number(rawSmtpPort);
  if (!Number.isInteger(smtpPort) || smtpPort <= 0 || smtpPort > 65535)
    throw new Error(`SMTP_PORT is not a valid port number: ${rawSmtpPort}`);

  const transporter = createTransport({
    host,
    port: smtpPort,
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
  });
  return { transporter, from };
}

const smtp = buildSmtpTransport();
const passwordResetMailer: PasswordResetMailer = smtp
  ? new NodemailerPasswordResetMailer(smtp.transporter, smtp.from)
  : noopPasswordResetMailer;
// Absent means no invitation mail is sent; the invite and its link still work.
const inviteMailer: InviteMailer | undefined = smtp
  ? new NodemailerInviteMailer(smtp.transporter, smtp.from)
  : undefined;

// Required outside tests. The agent mail forward reads the same limit through
// `readMaxFileSizeBytes`.
const maxFileSizeBytes = readMaxFileSizeBytes();
const blobStorage = new LocalFsBlobStorageWriter(resolveBlobStorageDir("FILES_STORAGE_DIR"));
const mailAttachmentStorage = new LocalFsBlobStorageWriter(resolveBlobStorageDir("MAIL_ATTACHMENTS_DIR"));
const speechGatewayToken = process.env.AI_GATEWAY_INTERNAL_TOKEN;
if (!speechGatewayToken) throw new Error("AI_GATEWAY_INTERNAL_TOKEN is not set");

// Behind Caddy on loopback the socket peer is always 127.0.0.1. Only the exact string "1" trusts
// `X-Forwarded-For`.
const trustProxy = process.env.TRUST_PROXY === "1";

const pool = createPool(connectionString);
await assertRuntimeRole(pool);
wireRealtimeHooks(pool);

// Re-UPSERTed every 15 seconds; `GET /healthz` reads it back from `process_heartbeats`, never from
// this handle.
startProcessHeartbeat(
  pool,
  { process: "api", pid: process.pid, version: process.env.APP_VERSION ?? "0.0.0" },
  { onError: (err) => logger.error({ err }, "Failed to record this process's heartbeat") },
);

const moduleRegistry = await loadFullModuleRegistry();
const dispatch = await createDispatcher(pool, {
  passwordResetMailer,
  inviteMailer,
  appBaseUrl,
  setupToken,
  moduleRegistry,
  blobStorage,
  mailAttachmentStorage,
  speechGateway: { port: Number(process.env.AI_GATEWAY_PORT ?? "3002"), token: speechGatewayToken },
  maxFileSizeBytes,
  trustProxy,
  customRouteDependencies,
});
const syncServer = await createSyncUpgradeHandler(pool);
const voiceServer = createVoiceChannel(pool, {
  handler: createVoiceSessionHandler(
    pool,
    { port: Number(process.env.AI_GATEWAY_PORT ?? "3002"), token: speechGatewayToken },
    syncServer,
    () => resolveModuleRuleKinds(moduleRegistry),
  ),
});

// The queue root that installs `CORE_CRONTAB` and hosts every `queueAffinity: 'api'` handler.
const queueRuntime = await createApiQueueRuntime(pool, moduleRegistry);

// This process hosts the one mail live-sync root, which discovers each active tenant's Mailboxes
// database itself. IMAP accounts get the IDLE lifecycle, Gmail the watch lifecycle and Graph the
// subscription lifecycle when configured; otherwise the noop lifecycle, which enqueues one
// `mailAccountSync` and leaves the account to the periodic sweep.
const gmailWatch = await resolveGmailWatchHosting(pool, process.env);
const graphSubscriptions = resolveGraphSubscriptionHosting(pool, process.env, appBaseUrl);
const mailLiveSync = createMailLiveSyncRoot(
  pool,
  createMailLiveSyncLifecycleFactory({
    pool,
    hosted: {
      imap: createImapIdleLifecycleFactory(pool),
      ...(gmailWatch ? { gmail_api: gmailWatch.lifecycle } : {}),
      ...(graphSubscriptions ? { graph_api: graphSubscriptions } : {}),
    },
  }),
  {
    onLifecycleError: (mailboxItemId, phase, err) => {
      logger.error({ err, mailboxItemId, phase }, "Mail live-sync lifecycle failed");
    },
  },
);
// Bound before the server listens, so no request reaches the control without the root.
mailLiveSyncControl.bind(mailLiveSync);
// Switching an account's Mail off in this process stops its live sync after the commit.
bindMailboxServiceLiveSyncStop((tenantId, mailboxItemId) =>
  mailLiveSyncControl.control.stopMailbox(tenantId, mailboxItemId),
);
await mailLiveSync.start();

// The one puller of the deployment's Gmail Pub/Sub subscription, started after the root and stopped
// before it.
const gmailPubSubDispatcher = gmailWatch ? createGmailPubSubDispatcherFor(pool, gmailWatch) : undefined;
await gmailPubSubDispatcher?.start();

// A tenant leaving `active` ends its sockets and hosted mailbox lifecycles at once, not on the next
// session check or discovery pass.
const tenantDeactivationListener = await startTenantDeactivationListener(pool, async (tenantId) => {
  syncServer.closeTenant(tenantId);
  voiceServer.closeTenant(tenantId);
  await mailLiveSync.stopTenant(tenantId);
});

const server = createServer(dispatch);

const shutdown = createGracefulShutdown({
  server,
  tenantDeactivationListener,
  syncServer,
  voiceServer,
  queueRuntime,
  gmailPubSubDispatcher,
  mailLiveSync,
  pool,
  logger,
});
registerShutdownSignals(shutdown);

// Any upgrade request outside the sync and voice routes gets its socket destroyed rather than
// silently ignored.
server.on("upgrade", (req, socket, head) => {
  withTraceContext({}, () => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/api/sync") {
      syncServer.handleUpgrade(req, socket, head);
      return;
    }
    if (pathname === "/api/voice") {
      voiceServer.handleUpgrade(req, socket, head);
      return;
    }
    socket.destroy();
  });
});

// Loopback only: the Caddy reverse proxy on the same host is the only public entry point.
server.listen(port, "127.0.0.1", () => {
  logger.info({ port }, "semprec-api listening");
});
