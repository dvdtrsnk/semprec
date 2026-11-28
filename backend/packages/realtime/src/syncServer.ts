import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Pool, PoolClient } from "pg";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { getDocById, getItemsByIds, getNotificationById, withTransaction } from "@alldots/data";
import { runAsSystem, runInTenant } from "@alldots/shared";
import {
  AGENT_STREAM_CHANNEL,
  REALTIME_CHANNEL,
  parseAgentStreamEnvelope,
  parseRealtimeEnvelope,
  type AgentStreamMessage,
  type RealtimeMessage,
} from "./pgNotifyPublisher.js";
import { logger } from "./logger.js";
import { createAgentRunWatchRegistry, type VoiceRunWatchInput } from "./agentRunWatch.js";
import { createDocSyncRegistry } from "./docSync.js";
import { decodeDocId, parseBinaryFrame, parseInboundFrame, type OutboundFrame } from "./protocolV1.js";
import { sendWithBackpressure } from "./backpressure.js";
import { createInvalidationCoalescer } from "./invalidationCoalescer.js";
import { createDocInvalidationThrottle } from "./docInvalidationThrottle.js";

/** The identity every `WS /api/sync` socket is associated with for its whole lifetime. */
export interface SyncIdentity {
  tenantId: string;
  userId: string;
  sessionId: string;
}

export interface SyncServerOptions {
  /**
   * Authenticates the upgrade request like any other route (session cookie or `Authorization: Bearer`). On `null`,
   * `handleUpgrade` responds 401 on the raw socket, so no socket ever exists for a bad credential.
   */
  authenticate: (req: IncomingMessage) => Promise<SyncIdentity | null>;
  /**
   * Called on every heartbeat tick as a fallback for a socket whose process missed its `session_revoked` notification.
   */
  revalidateSession: (sessionId: string) => Promise<boolean>;
  /** Defaults to 30 seconds. */
  heartbeatIntervalMs?: number;
}

export interface SyncServer {
  subscribeVoice(input: VoiceRunWatchInput): Promise<() => Promise<void>>;
  /** Wire this to the underlying `http.Server`'s `'upgrade'` event for the `/api/sync` path. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /**
   * Closes every open socket of `tenantId` with 4401 `"account deactivated"`. An upgrade of that tenant that began
   * authenticating before this call is closed the same way once it attaches.
   */
  closeTenant(tenantId: string): void;
  close(): Promise<void>;
}

/** The only `type` values a drop warning may name. */
const KNOWN_MESSAGE_TYPES: ReadonlySet<string> = new Set<RealtimeMessage["type"] | AgentStreamMessage["type"]>([
  "invalidation",
  "doc_update",
  "agent_run_event",
  "notification_created",
  "notification_read_state",
  "session_revoked",
  "agent_run_delta",
]);

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/** Outside the 1000-1015 range reserved by the protocol. */
export const SESSION_REVOKED_CLOSE_CODE = 4401;

/**
 * RFC 6455 1012 ("Service Restart"), for both a LISTEN-connection outage and a controlled shutdown. NOTIFY is never
 * persisted, so there is nothing to replay: every client is forced through its own resume path.
 */
const SERVICE_RESTART_CLOSE_CODE = 1012;

/** `ws`'s `maxPayload` closes an over-limit connection (1009) before the frame reaches the handler. */
const MAX_INBOUND_FRAME_BYTES = 2_000_000;

/** An unresponsive socket is closed within ~90s. */
const MAX_MISSED_PONGS = 2;

/** Base and cap for the LISTEN-connection reconnect backoff after an outage. */
const LISTEN_RECONNECT_BASE_DELAY_MS = 200;
const LISTEN_RECONNECT_MAX_DELAY_MS = 5_000;

function rawDataToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data);
}

function rejectUpgrade(socket: Duplex): void {
  socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  socket.destroy();
}

/**
 * `WS /api/sync`: the one authenticated, multiplexed connection per client, bound to a verified user/session for its
 * whole lifetime. Owns this process's single LISTEN connection on `REALTIME_CHANNEL`. Every payload is a `{ tenantId,
 * message }` envelope; an unparseable one is dropped and logged, a valid one is handled inside
 * `runInTenant(envelope.tenantId)`, and nothing is ever delivered to another tenant's sockets.
 *
 * - `session_revoked` closes every socket of that exact session with 4401.
 * - `invalidation` sends a thin frame; the client refetches over REST. Item/schema invalidations go to the acting
 *   user's sockets, or the whole tenant for a system write. Owner/actor-scoped invalidations (`approvalRequest`,
 *   `agentRuns`, `notificationPreferences`, `badgeCounts`, `account`) go only to the named user and are dropped when no
 *   user is named; the other scopes go tenant-wide, narrowed to one user when the message names one.
 * - `notification_created` / `notification_read_state` fetch the current row and send it only to its own `userId`:
 *   the one place a full row is sent, because a notification's pre-rendered `title` has no second enforcement layer.
 * - `doc_update` fans out to `docSync`, which forwards it only to sockets that have that document open.
 *
 * `agent:watch` creates an authorized, cursor-backed subscription: durable events are replayed from `agent_run_events`
 * and live references follow without a gap. Typing deltas arrive on `AGENT_STREAM_CHANNEL` and reach only those
 * watchers. `doc:open`/`doc:close` and binary sync frames are handled through `docSync`.
 */
export async function createSyncServer(pool: Pool, options: SyncServerOptions): Promise<SyncServer> {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND_FRAME_BYTES });
  const identityByClient = new WeakMap<WebSocket, SyncIdentity>();
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const agentRunWatch = createAgentRunWatchRegistry(pool);
  const docSync = createDocSyncRegistry(pool);
  let closed = false;
  // Per-tenant close counter, so an upgrade can tell whether its tenant was closed after it began authenticating.
  let tenantCloseCount = 0;
  const lastTenantClose = new Map<string, number>();

  const invalidationCoalescer = createInvalidationCoalescer();

  function deliver(client: WebSocket, frame: OutboundFrame): void {
    if (frame.type === "invalidate" && (frame.scope === "item" || frame.scope === "relation")) {
      invalidationCoalescer.enqueue(client, frame);
      return;
    }
    sendWithBackpressure(client, JSON.stringify(frame));
  }

  function attachClient(ws: WebSocket, identity: SyncIdentity): void {
    identityByClient.set(ws, identity);

    // `ws` emits protocol faults (e.g. a frame over `maxPayload`) after closing the connection itself; without an
    // `'error'` listener the emitter would throw and crash the process over one client's bad frame.
    ws.on("error", (err: unknown) => {
      logger.error({ err }, "Sync server client socket error");
    });

    // Frames outside the protocol-v1 catalog are dropped without affecting this or any other connection.
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        const frame = parseBinaryFrame(rawDataToBuffer(data));
        if (!frame) return;
        const docId = decodeDocId(frame.docId);
        if (!docId) return;
        docSync.handleBinaryFrame(ws, identity.tenantId, docId, frame.payload).catch((err: unknown) => {
          logger.error({ err }, "Sync server failed to handle a doc binary frame");
        });
        return;
      }
      const frame = parseInboundFrame(rawDataToBuffer(data).toString("utf8"));
      if (!frame) return;
      switch (frame.type) {
        case "doc:open":
          docSync.handleOpen(ws, identity.tenantId, frame.docId).catch((err: unknown) => {
            logger.error({ err }, "Sync server failed to handle doc:open");
          });
          return;
        case "doc:close":
          docSync.handleClose(ws, frame.docId);
          return;
        case "agent:watch":
          agentRunWatch
            .watch(ws, identity.tenantId, identity.userId, frame.runId, frame.afterEventId)
            .catch((err: unknown) => {
              logger.error({ err }, "Sync server failed to watch an agent run");
            });
          return;
        case "agent:unwatch":
          agentRunWatch.unwatch(ws, frame.runId);
          return;
        default:
          return;
      }
    });

    // RFC 6455 control-frame ping, answered by browsers and `URLSession` without client code. A connection that misses
    // `MAX_MISSED_PONGS` consecutive pongs is dropped without waiting for a close handshake.
    let missedPongs = 0;
    ws.on("pong", () => {
      missedPongs = 0;
    });

    const heartbeat = setInterval(() => {
      if (missedPongs >= MAX_MISSED_PONGS) {
        clearInterval(heartbeat);
        ws.terminate();
        return;
      }
      missedPongs += 1;
      if (ws.readyState === ws.OPEN) ws.ping();

      // Fallback for a lost `session_revoked` NOTIFY.
      runAsSystem("realtime:revalidate", () => options.revalidateSession(identity.sessionId))
        .then((active) => {
          if (!active && ws.readyState === ws.OPEN) ws.close(SESSION_REVOKED_CLOSE_CODE, "session revoked");
        })
        .catch((err: unknown) => {
          logger.error({ err }, "Sync heartbeat session revalidation failed");
        });
    }, heartbeatIntervalMs);

    ws.on("close", () => {
      clearInterval(heartbeat);
      identityByClient.delete(ws);
      invalidationCoalescer.discard(ws);
      agentRunWatch.handleSocketClosed(ws);
      docSync.handleSocketClosed(ws);
    });
  }

  async function connectListenClient(): Promise<PoolClient> {
    return runAsSystem("realtime:listen", async () => {
      const client = await pool.connect();
      try {
        await client.query(`LISTEN ${REALTIME_CHANNEL}`);
        await client.query(`LISTEN ${AGENT_STREAM_CHANNEL}`);
      } catch (err) {
        client.release(true);
        throw err;
      }
      return client;
    });
  }

  let listenClient: PoolClient = await connectListenClient();
  // `onError` and `close()` can race to release the same broken connection.
  let listenClientActive = true;

  /** Sends to the open sockets of `tenantId`, narrowed to one user's sockets when `userId` is given. */
  function sendToTenant(tenantId: string, frame: OutboundFrame, userId?: string): void {
    for (const client of wss.clients) {
      const identity = identityByClient.get(client);
      if (identity?.tenantId !== tenantId || client.readyState !== client.OPEN) continue;
      if (userId !== undefined && identity.userId !== userId) continue;
      deliver(client, frame);
    }
  }

  async function resolveDocInvalidation(tenantId: string, docId: string) {
    return runInTenant(tenantId, () =>
      withTransaction(pool, async (client) => {
        const doc = await getDocById(client, docId);
        if (!doc) return null;
        const [item] = await getItemsByIds(client, [doc.itemId]);
        if (!item) return null;
        return {
          type: "invalidate",
          scope: "doc",
          docId,
          itemId: item.id,
          databaseId: item.databaseId,
          lastEditedAt: doc.lastEditedAt,
        } as const;
      }),
    );
  }

  const docInvalidations = createDocInvalidationThrottle(
    resolveDocInvalidation,
    (tenantId, frame) => sendToTenant(tenantId, frame),
    () => logger.error({ stage: "doc_invalidation" }, "Sync server failed to invalidate a document"),
  );

  function closeAll(code: number, reason: string): void {
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.close(code, reason);
    }
  }

  /** Shared by `notification_created` and `notification_read_state`: both send the notification's current state. */
  async function forwardNotification(tenantId: string, userId: string, notificationId: string): Promise<void> {
    const notification = await getNotificationById(pool, notificationId);
    // Deleted, or the fetch lost a race: the client converges on its next refetch, so dropping is safe.
    if (!notification) return;
    // Ownership is re-checked against the fetched row: a mismatched payload must never cause cross-user delivery.
    if (notification.userId !== userId) return;
    sendToTenant(tenantId, { type: "notification", notification }, userId);
  }

  const agentEventDeliveryTails = new Map<string, { promise: Promise<void> }>();

  function enqueueAgentEvent(tenantId: string, runId: string, eventId: string): void {
    const entry = { promise: Promise.resolve() };
    const preceding = agentEventDeliveryTails.get(runId)?.promise ?? Promise.resolve();
    entry.promise = preceding
      .then(() => agentRunWatch.forwardEvent(tenantId, runId, eventId))
      .catch((err: unknown) => {
        // Keeps this run's delivery queue usable without delaying other runs or pretending the fault was forwarded.
        logger.error({ err }, "Sync server failed to forward an agent run event");
      })
      .then(() => {
        if (agentEventDeliveryTails.get(runId) === entry) agentEventDeliveryTails.delete(runId);
      });
    agentEventDeliveryTails.set(runId, entry);
  }

  /**
   * Logs a dropped envelope by channel and inner `type`; the type is logged only when it is a catalog literal, so an
   * invalid payload cannot put arbitrary text in the log.
   */
  function dropWithoutTenant(channel: string, raw: unknown): void {
    let type: unknown;
    if (typeof raw === "object" && raw !== null) {
      const inner = (raw as { message?: unknown }).message ?? raw;
      if (typeof inner === "object" && inner !== null) type = (inner as { type?: unknown }).type;
    }
    logger.warn(
      { channel, type: typeof type === "string" && KNOWN_MESSAGE_TYPES.has(type) ? type : undefined },
      "realtime_message_without_tenant",
    );
  }

  const onNotification = (msg: { channel: string; payload?: string }) => {
    if (msg.payload === undefined) return;

    if (msg.channel !== AGENT_STREAM_CHANNEL && msg.channel !== REALTIME_CHANNEL) return;

    let rawParsed: unknown;
    try {
      rawParsed = JSON.parse(msg.payload);
    } catch {
      dropWithoutTenant(msg.channel, undefined);
      return;
    }

    if (msg.channel === AGENT_STREAM_CHANNEL) {
      const envelope = parseAgentStreamEnvelope(rawParsed);
      if (!envelope) {
        dropWithoutTenant(msg.channel, rawParsed);
        return;
      }
      agentRunWatch.forwardDelta(envelope.tenantId, envelope.message);
      return;
    }

    const envelope = parseRealtimeEnvelope(rawParsed);
    if (!envelope) {
      dropWithoutTenant(msg.channel, rawParsed);
      return;
    }
    const { tenantId, message: parsed } = envelope;

    runInTenant(tenantId, () => {
      switch (parsed.type) {
        case "session_revoked": {
          const revokedSessionId = parsed.sessionId;
          for (const client of wss.clients) {
            const identity = identityByClient.get(client);
            if (
              identity?.sessionId === revokedSessionId &&
              identity.tenantId === tenantId &&
              client.readyState === client.OPEN
            ) {
              client.close(SESSION_REVOKED_CLOSE_CODE, "session revoked");
            }
          }
          return;
        }
        case "invalidation": {
          if (parsed.scope === "sempThread") {
            sendToTenant(tenantId, { type: "invalidate", scope: "sempThread", threadId: parsed.threadId });
            return;
          }
          if (parsed.scope === "approvalRequest") {
            // Owner-only: a message without an owner is dropped, never widened to the tenant.
            if (parsed.userId === undefined) {
              logger.warn({ type: parsed.type, scope: parsed.scope }, "realtime_approval_request_without_owner");
              return;
            }
            sendToTenant(
              tenantId,
              { type: "invalidate", scope: "approvalRequest", approvalRequestId: parsed.approvalRequestId },
              parsed.userId,
            );
            return;
          }
          if (parsed.scope === "mailThread") {
            sendToTenant(
              tenantId,
              { type: "invalidate", scope: "mailThread", threadId: parsed.threadId },
              parsed.userId,
            );
            return;
          }
          if (parsed.scope === "agentRuns") {
            // Actor-only: a message without a user is dropped, never widened to the tenant.
            if (parsed.userId === undefined) {
              logger.warn({ type: parsed.type, scope: parsed.scope }, "realtime_agent_runs_without_user");
              return;
            }
            sendToTenant(
              tenantId,
              {
                type: "invalidate",
                scope: "agentRuns",
                projectItemId: parsed.projectItemId,
                agentRunId: parsed.agentRunId,
              },
              parsed.userId,
            );
            return;
          }
          if (parsed.scope === "projectAgent") {
            sendToTenant(tenantId, {
              type: "invalidate",
              scope: "projectAgent",
              projectItemId: parsed.projectItemId,
            });
            return;
          }
          if (parsed.scope === "sempStatus") {
            sendToTenant(tenantId, { type: "invalidate", scope: "sempStatus" });
            return;
          }
          if (parsed.scope === "overview") {
            sendToTenant(tenantId, { type: "invalidate", scope: "overview" });
            return;
          }
          if (parsed.scope === "mcpServers") {
            sendToTenant(tenantId, { type: "invalidate", scope: "mcpServers" });
            return;
          }
          if (
            parsed.scope === "notificationPreferences" ||
            parsed.scope === "badgeCounts" ||
            parsed.scope === "account"
          ) {
            sendToTenant(tenantId, { type: "invalidate", scope: parsed.scope }, parsed.userId);
            return;
          }
          if (parsed.scope === "inboxCards") {
            sendToTenant(
              tenantId,
              { type: "invalidate", scope: "inboxCards", op: parsed.op, cardId: parsed.cardId },
              parsed.userId,
            );
            return;
          }
          if (parsed.scope === "relation") {
            sendToTenant(
              tenantId,
              {
                type: "invalidate",
                scope: "relation",
                databaseId: parsed.databaseId,
                itemId: parsed.itemId,
                propertyKey: parsed.propertyKey,
                op: parsed.op,
              },
              parsed.userId,
            );
            return;
          }
          const frame: OutboundFrame =
            parsed.scope === "item"
              ? {
                  type: "invalidate",
                  scope: "item",
                  databaseId: parsed.databaseId,
                  itemId: parsed.itemId,
                  op: parsed.op,
                  updatedAt: parsed.updatedAt,
                }
              : { type: "invalidate", scope: "schema", databaseId: parsed.databaseId };
          sendToTenant(tenantId, frame, parsed.userId);
          return;
        }
        case "notification_created": {
          forwardNotification(tenantId, parsed.userId, parsed.notificationId).catch((err: unknown) => {
            logger.error({ err }, "Sync server failed to forward a created notification");
          });
          return;
        }
        case "notification_read_state": {
          for (const notificationId of parsed.notificationIds) {
            forwardNotification(tenantId, parsed.userId, notificationId).catch((err: unknown) => {
              logger.error({ err }, "Sync server failed to forward a notification read-state update");
            });
          }
          return;
        }
        case "agent_run_event": {
          enqueueAgentEvent(tenantId, parsed.agentRunId, parsed.eventId);
          return;
        }
        case "doc_update": {
          docInvalidations.enqueue(tenantId, parsed.docId);
          docSync.fanOutDocUpdate(tenantId, parsed.docId, parsed.updateId).catch((err: unknown) => {
            logger.error({ err }, "Sync server failed to fan out a doc update");
          });
          return;
        }
        default:
          return;
      }
    });
  };
  function detachListenClient(): void {
    if (!listenClientActive) return;
    listenClientActive = false;
    listenClient.off("notification", onNotification);
    listenClient.off("error", onError);
    listenClient.release(true);
  }

  /**
   * Retries with capped exponential backoff until success or `close()`. On success every socket is closed with 1012, as
   * at the outage start: one that connected during the gap cannot tell what it missed.
   */
  async function reconnectListen(): Promise<void> {
    let delay = LISTEN_RECONNECT_BASE_DELAY_MS;
    while (!closed) {
      try {
        const client = await connectListenClient();
        if (closed) {
          // `close()` ran while this attempt was in flight; the client must not become the active `listenClient`.
          client.release(true);
          return;
        }
        listenClient = client;
        listenClientActive = true;
        listenClient.on("notification", onNotification);
        listenClient.on("error", onError);
        closeAll(SERVICE_RESTART_CLOSE_CODE, "listen connection restored");
        return;
      } catch (err) {
        logger.error({ err }, "Sync server failed to reconnect its LISTEN connection");
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, LISTEN_RECONNECT_MAX_DELAY_MS);
      }
    }
  }

  listenClient.on("notification", onNotification);

  // Losing the LISTEN connection loses NOTIFYs that are never persisted, so every socket is forced to resume. Without
  // this handler a dropped connection would crash the process.
  const onError = (err: unknown) => {
    logger.error({ err }, "Sync server LISTEN connection error");
    detachListenClient();
    agentRunWatch.resetVoice();
    closeAll(SERVICE_RESTART_CLOSE_CODE, "listen connection lost");
    if (!closed) {
      reconnectListen().catch((reconnectErr: unknown) => {
        logger.error({ err: reconnectErr }, "Sync server LISTEN reconnect loop failed unexpectedly");
      });
    }
  };
  listenClient.on("error", onError);

  return {
    async subscribeVoice(input) {
      if (closed || !listenClientActive) throw new Error("Voice run watch unavailable");
      return agentRunWatch.subscribeVoice(input);
    },
    handleUpgrade(req, socket, head) {
      const closesBefore = tenantCloseCount;
      runAsSystem("realtime:upgrade", () => options.authenticate(req))
        .then((identity) => {
          if (!identity) {
            rejectUpgrade(socket);
            return;
          }
          // `close()` may have run during authentication: its close-frame loop is done, so an attached client would
          // never get a close frame and `wss.close()` would wait forever.
          if (closed) {
            rejectUpgrade(socket);
            return;
          }
          wss.handleUpgrade(req, socket, head, (ws) => {
            attachClient(ws, identity);
            // `closeTenant` ran for this tenant during authentication and never saw this socket.
            if ((lastTenantClose.get(identity.tenantId) ?? 0) > closesBefore) {
              ws.close(SESSION_REVOKED_CLOSE_CODE, "account deactivated");
            }
          });
        })
        .catch((err: unknown) => {
          logger.error({ err }, "Sync upgrade authentication failed");
          rejectUpgrade(socket);
        });
    },
    closeTenant(tenantId) {
      agentRunWatch.closeTenant(tenantId);
      lastTenantClose.set(tenantId, ++tenantCloseCount);
      for (const client of wss.clients) {
        const identity = identityByClient.get(client);
        if (identity?.tenantId === tenantId && client.readyState === client.OPEN) {
          client.close(SESSION_REVOKED_CLOSE_CODE, "account deactivated");
        }
      }
    },
    async close() {
      closed = true;
      agentRunWatch.close();
      const docInvalidationsClosed = docInvalidations.close();
      detachListenClient();
      // A delivered 1012 close frame (not `terminate()`) tells each client to reconnect elsewhere. The `noServer` `wss`
      // does not wait on handshakes, so an unresponsive client is dropped by `ws`'s close timeout instead of hanging.
      closeAll(SERVICE_RESTART_CLOSE_CODE, "server shutting down");
      const results = await Promise.allSettled([
        new Promise<void>((resolve, reject) => wss.close((err) => (err ? reject(err) : resolve()))),
        docInvalidationsClosed,
      ]);
      const failures: unknown[] = [];
      for (const result of results) if (result.status === "rejected") failures.push(result.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Sync server shutdown failed");
    },
  };
}
