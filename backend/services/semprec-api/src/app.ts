import { createRecordingsRequestListener } from "./recordingsHandler.js";
import {
  createCollectionMetadataResolver,
  createMailTransportFactory,
  resolveModuleRuleKinds,
  type CollectionMetadataResolver,
  type HeartbeatRuleKindRegistry,
} from "@semprec/data";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { CAPABILITY_IDS, withTraceContext, type GenericApplicationPort } from "@semprec/shared";
import { createGenericApplicationService, createGenericOperationGateway } from "@semprec/application";
import type { BlobStorageWriter, InviteMailer, PasswordResetMailer, loadFullModuleRegistry } from "@semprec/data";
import { createMcpRequestListener } from "./mcp/mcpHandler.js";
import {
  createCustomRouteDependencies,
  mountCustomRoutes,
  type CustomRouteDependencies,
} from "./adapter/customRouteMount.js";
import { mountRoutes, type RouteDefinition } from "./adapter/routeTable.js";
import { createSempThreadRoutes } from "./sempThreadsHandler.js";
import { createSempSpeechRequestListener, isMessageSpeechPath } from "./sempSpeechHandler.js";
import type { HttpAiGatewayClientConfig } from "@semprec/ai-gateway-client";
import { createAccountExportDownloadListener, createAccountRoutes } from "./accountHandler.js";
import { createAdminRoutes } from "./adminHandler.js";
import { createDatabaseRoutes } from "./databasesHandler.js";
import { createItemRoutes } from "./itemsHandler.js";
import { createPageChangesRoutes } from "./pageChangesHandler.js";
import { createSearchRoutes } from "./searchHandler.js";
import { createPropertyRoutes } from "./propertiesHandler.js";
import { createViewRoutes } from "./viewsHandler.js";
import { createMcpAgentPageRequestListener } from "./mcpAgentPageHandler.js";
import { createApprovalRequestsRequestListener } from "./approvalRequestsHandler.js";
import { createAgentRunRequestListener } from "./agentRunHandler.js";
import { createAuthRequestListener } from "./authHandler.js";
import { createNotificationsRequestListener } from "./notificationsHandler.js";
import { createSetupRequestListener } from "./setupHandler.js";
import { createInvitationRequestListener } from "./invitationHandler.js";
import { createHealthzRequestListener } from "./healthzHandler.js";
import { createServerInfoRequestListener } from "./serverInfoHandler.js";
import { createSchemaRequestListener } from "./schemaHandler.js";
import { createFilesRequestListener } from "./filesHandler.js";
import { createBlobUploadRequestListener } from "./blobUploadHandler.js";
import { createBlobsRequestListener } from "./blobsHandler.js";
import {
  createPageMarkdownRequestListener,
  createPageReplaceRequestListener,
  createPageInsertRequestListener,
  isPageInsertPath,
  isPageMarkdownPath,
} from "./pageMarkdownHandler.js";
import { createGraphWebhookRequestListener } from "./graphWebhookHandler.js";
import { createMailOauthCallbackRequestListener, MAIL_OAUTH_CALLBACK_PATH } from "./mailOauthCallbackHandler.js";
import { sendJson } from "./adapter/http.js";
import { createClientIpThrottle } from "./clientIpThrottle.js";
import { isAllowedOrigin } from "./originCheck.js";
import { logger } from "./logger.js";

/** Methods a browser sends without a same-origin check: they cannot change state. */
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

export interface AppOptions {
  passwordResetMailer: PasswordResetMailer;
  /** Absent when SMTP is not configured: invitations are still issued, but no mail is sent. */
  inviteMailer?: InviteMailer;
  appBaseUrl: string;
  setupToken: string;
  /** Every active module's manifest, loaded once at startup. */
  moduleRegistry: Awaited<ReturnType<typeof loadFullModuleRegistry>>;
  blobStorage: BlobStorageWriter;
  /** `GET /api/blobs/:id` also reads from it. Defaults to `blobStorage`. */
  mailAttachmentStorage?: BlobStorageWriter;
  speechGateway?: HttpAiGatewayClientConfig;
  maxFileSizeBytes: number;
  /** Login throttling keys on the last `X-Forwarded-For` hop. */
  trustProxy?: boolean;
  /**
   * Absent means the empty container. `createDispatcher` adds its registry provider, and a
   * `throttle` when the container carries none.
   */
  customRouteDependencies?: CustomRouteDependencies;
}

/**
 * In mount order. `__tests__/routeMatrixCoverage.unit.test.ts` reads it to check each route has a
 * `ROUTE_MATRIX` entry.
 */
export function createResourceRouteDefinitions(
  pool: Pool,
  options: AppOptions,
  heartbeatRuleKinds: () => Promise<HeartbeatRuleKindRegistry>,
  genericApplicationService: GenericApplicationPort,
  collectionMetadataResolver: CollectionMetadataResolver,
): RouteDefinition[] {
  return [
    ...createAccountRoutes(pool, options),
    ...createSempThreadRoutes(pool, heartbeatRuleKinds),
    ...createAdminRoutes(pool, options),
    ...createDatabaseRoutes(genericApplicationService, options.moduleRegistry),
    ...createPropertyRoutes(genericApplicationService, options.moduleRegistry),
    ...createViewRoutes(genericApplicationService, pool),
    ...createItemRoutes(genericApplicationService, pool, collectionMetadataResolver),
    ...createPageChangesRoutes(genericApplicationService),
    ...createSearchRoutes(genericApplicationService),
  ];
}

/**
 * `serve.ts` hands the result to `http.createServer`; the route-matrix tests drive it the same way
 * in-process.
 *
 * Module custom routes are tried first, then the generic resource routes through `mountRoutes`;
 * `mcpAgentPageListener` answers 404 for anything left unmatched.
 */
export async function createDispatcher(
  pool: Pool,
  options: AppOptions,
): Promise<(req: IncomingMessage, res: ServerResponse) => void> {
  const customRouteDefinitions = await options.moduleRegistry.getCustomRouteDefinitions();
  // Resolved per call, so a module activated or deactivated since the last request is reflected.
  const heartbeatRuleKinds = () => resolveModuleRuleKinds(options.moduleRegistry);
  const callerDependencies = options.customRouteDependencies ?? createCustomRouteDependencies();
  // The custom routes' container also builds the module tools of a human `/mcp` session, so the
  // draft send tool sends through the send route's transports.
  const routeDependencies: CustomRouteDependencies = {
    ...callerDependencies,
    heartbeatRuleKinds,
    // One limiter for this dispatcher's lifetime, so every password connect request counts in the
    // same windows. A caller's own instance is kept.
    throttle: callerDependencies.throttle ?? createClientIpThrottle(),
    // The draft attachment limit of a mailbox without a provider limit is this dispatcher's upload
    // cap, whatever the container carries.
    maxFileSizeBytes: options.maxFileSizeBytes,
    // Transports of the mailbox's sync mode, built from the container's OAuth clients. A caller's
    // own `send` is kept.
    mailServerClients: {
      ...callerDependencies.mailServerClients,
      send: callerDependencies.mailServerClients?.send ?? {
        transports: createMailTransportFactory(pool, {
          ...(callerDependencies.oauth?.gmail ? { gmailOAuthClient: callerDependencies.oauth.gmail } : {}),
          ...(callerDependencies.oauth?.msGraph ? { graphOAuthClient: callerDependencies.oauth.msGraph } : {}),
          ...(callerDependencies.outboundHttp ? { fetchImpl: callerDependencies.outboundHttp } : {}),
        }),
        attachmentStorage: {
          files: options.blobStorage,
          mailAttachments: options.mailAttachmentStorage ?? options.blobStorage,
        },
      },
    },
  };
  const dispatchCustomRoute = mountCustomRoutes(pool, customRouteDefinitions, routeDependencies);
  // The one `GenericApplicationPort` per pool, shared by every generic resource route so there is
  // no second write path.
  const collectionMetadataResolver = await createCollectionMetadataResolver(options.moduleRegistry);
  const genericApplicationService = createGenericApplicationService(pool, collectionMetadataResolver);
  const dispatchResourceRoute = mountRoutes(
    pool,
    createResourceRouteDefinitions(
      pool,
      options,
      heartbeatRuleKinds,
      genericApplicationService,
      collectionMetadataResolver,
    ),
  );
  // A separate `GenericOperationGateway` for MCP over the same pool, sharing no state with the REST
  // service. `grantedCapabilities` is the schema core module's own: an authenticated MCP session
  // has no project to compute a per-run manifest against.
  const mcpGateway = createGenericOperationGateway(pool, collectionMetadataResolver);
  const registeredModuleCapabilities = await options.moduleRegistry.getCapabilities();
  const mcpGrantedCapabilities = new Set(CAPABILITY_IDS.filter((id) => registeredModuleCapabilities.includes(id)));
  const mcpListener = await createMcpRequestListener(
    pool,
    mcpGateway,
    mcpGrantedCapabilities,
    options.moduleRegistry,
    routeDependencies,
  );
  // Also accepts a scoped run credential, through the same gateway and capability set as `/mcp`.
  const pageInsertListener = createPageInsertRequestListener(
    pool,
    genericApplicationService,
    mcpGateway,
    mcpGrantedCapabilities,
  );
  const pageReplaceListener = createPageReplaceRequestListener(
    pool,
    genericApplicationService,
    mcpGateway,
    mcpGrantedCapabilities,
  );
  const mcpAgentPageListener = createMcpAgentPageRequestListener(pool, routeDependencies.aiGateway);
  const approvalRequestsListener = createApprovalRequestsRequestListener(pool);
  const agentRunListener = createAgentRunRequestListener(pool, options.moduleRegistry);
  const authListener = createAuthRequestListener(pool, {
    passwordResetMailer: options.passwordResetMailer,
    appBaseUrl: options.appBaseUrl,
    trustProxy: options.trustProxy,
  });
  const notificationsListener = createNotificationsRequestListener(pool);
  const setupListener = createSetupRequestListener(pool, { setupToken: options.setupToken });
  const invitationListener = createInvitationRequestListener(pool, { trustProxy: options.trustProxy ?? false });
  const healthzListener = createHealthzRequestListener(pool);
  const serverInfoListener = createServerInfoRequestListener();
  const schemaListener = createSchemaRequestListener(pool, options.moduleRegistry);
  const filesListener = createFilesRequestListener(pool, {
    storage: options.blobStorage,
    maxFileSizeBytes: options.maxFileSizeBytes,
  });
  const recordingsListener = createRecordingsRequestListener(pool, {
    storage: options.blobStorage,
    maxFileSizeBytes: options.maxFileSizeBytes,
  });
  const blobUploadListener = createBlobUploadRequestListener(pool, {
    storage: options.blobStorage,
    maxFileSizeBytes: options.maxFileSizeBytes,
  });
  const blobsListener = createBlobsRequestListener(pool, {
    files: options.blobStorage,
    mailAttachments: options.mailAttachmentStorage ?? options.blobStorage,
  });
  const pageMarkdownListener = createPageMarkdownRequestListener(pool, genericApplicationService);
  const speechListener = createSempSpeechRequestListener(pool, options.blobStorage, options.speechGateway);
  const graphWebhookListener = createGraphWebhookRequestListener(pool);
  const mailOauthCallbackListener = createMailOauthCallbackRequestListener(pool);
  const accountExportDownloadListener = createAccountExportDownloadListener(pool, { storage: options.blobStorage });

  // Every request mints its own trace id; `AsyncLocalStorage` carries it through the promise chains
  // the matched route starts.
  function dispatch(req: IncomingMessage, res: ServerResponse): void {
    // A page on another origin can send an unsafe request with the session cookie attached, so
    // every such request is checked before routing.
    if (!SAFE_METHODS.has(req.method ?? "") && !isAllowedOrigin(req)) {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      logger.warn({ method: req.method, path: pathname }, "origin_not_allowed");
      sendJson(res, 403, { error: { code: "origin_not_allowed" } });
      return;
    }
    withTraceContext({}, () => dispatchTraced(req, res));
  }

  function dispatchTraced(req: IncomingMessage, res: ServerResponse): void {
    if (dispatchCustomRoute(req, res)) return;
    if (dispatchResourceRoute(req, res)) return;

    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "POST" && isMessageSpeechPath(pathname)) {
      speechListener(req, res);
      return;
    }
    if (req.method === "GET" && isPageMarkdownPath(pathname)) {
      pageMarkdownListener(req, res);
      return;
    }
    if (req.method === "PUT" && isPageMarkdownPath(pathname)) {
      pageReplaceListener(req, res);
      return;
    }
    if (req.method === "POST" && isPageInsertPath(pathname)) {
      pageInsertListener(req, res);
      return;
    }
    if (pathname === "/healthz") {
      void healthzListener(req, res);
      return;
    }
    if (pathname === "/api/server-info") {
      serverInfoListener(req, res);
      return;
    }
    if (pathname === "/api/schema") {
      void schemaListener(req, res);
      return;
    }
    if (pathname === "/mcp") {
      void mcpListener(req, res);
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
    if (pathname === "/api/invitations/accept") {
      void invitationListener(req, res);
      return;
    }
    if (pathname === "/api/recordings" && req.method === "POST") {
      recordingsListener(req, res);
      return;
    }
    if (pathname === "/api/files" && req.method === "POST") {
      void filesListener(req, res);
      return;
    }
    if (pathname === "/api/blobs" && req.method === "POST") {
      void blobUploadListener(req, res);
      return;
    }
    if (pathname.startsWith("/api/blobs/") && req.method === "GET") {
      void blobsListener(req, res);
      return;
    }
    if (pathname.startsWith("/api/account/exports/") && pathname.endsWith("/download") && req.method === "GET") {
      void accountExportDownloadListener(req, res);
      return;
    }
    if (pathname === "/api/mail/graph/webhook") {
      void graphWebhookListener(req, res);
      return;
    }
    // The provider's redirect target, served without a session.
    if (pathname === MAIL_OAUTH_CALLBACK_PATH && req.method === "GET") {
      mailOauthCallbackListener(req, res);
      return;
    }
    void mcpAgentPageListener(req, res);
  }

  return dispatch;
}
