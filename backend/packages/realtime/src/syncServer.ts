import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Pool, PoolClient } from "pg";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { getNotificationById } from "@semprec/data";
import { createAgentRunWatchRegistry } from "./agentRunWatch.js";
import {
  AGENT_STREAM_CHANNEL,
  REALTIME_CHANNEL,
  parseAgentStreamMessage,
  parseRealtimeMessage,
  type RealtimeMessage,
} from "./pgNotifyPublisher.js";
import { parseBinaryFrame, parseInboundFrame, type OutboundFrame } from "./protocolV1.js";

/** The identity every `WS /api/sync` socket is associated with for its whole lifetime. */
export interface SyncIdentity {
  userId: string;
  sessionId: string;
}

export interface SyncServerOptions {
  /**
   * Authenticates the HTTP upgrade request the same way any other route does — the web session
   * cookie or a native client's `Authorization: Bearer` token. Returns `null` for missing,
   * invalid, expired, or revoked credentials; `handleUpgrade` then responds 401 on the raw socket
   * and never completes the WS handshake, so no socket is ever created for a bad credential.
   */
  authenticate: (req: IncomingMessage) => Promise<SyncIdentity | null>;
  /**
   * Re-checks that a connection's session is still active. Called on every heartbeat tick as a
   * fallback to the NOTIFY-driven close below, for a socket whose process missed (or connected
   * around) the `session_revoked` notification for its own session.
   */
  revalidateSession: (sessionId: string) => Promise<boolean>;
  /** How often each socket's session is revalidated. Defaults to 30 seconds. */
  heartbeatIntervalMs?: number;
}

export interface SyncServer {
  /** Wire this to the underlying `http.Server`'s `'upgrade'` event for the `/api/sync` path. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): Promise<void>;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/** WS close code for "your session was revoked" (issue #160's Task; outside the standard 1000-1015 range reserved for the protocol itself, so it can't collide with one). */
const SESSION_REVOKED_CLOSE_CODE = 4401;

/**
 * Caps every inbound frame at 1 MiB. Nothing in protocol-v1's closed catalog needs anywhere near
 * that (control frames are a handful of bytes; a real CRDT-update binary frame's size is a later
 * sibling issue's concern) — this exists so one authenticated client can't hold the process's
 * memory hostage with an oversized frame.
 */
const MAX_INBOUND_FRAME_BYTES = 1_000_000;

function rawDataToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data);
}

/** Rejects an upgrade before any WS handshake starts — the request never becomes a socket. */
function rejectUpgrade(socket: Duplex): void {
  socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  socket.destroy();
}

/**
 * `WS /api/sync` (issue #160/#161): the one authenticated, multiplexed connection every realtime
 * stream rides — one socket per client, associated with a verified user/session identity for its
 * whole lifetime. Owns this process's single dedicated Postgres LISTEN connection on
 * `REALTIME_CHANNEL` and acts on four message kinds from it:
 *
 * - `session_revoked` closes every socket authenticated as that exact session with 4401, leaving
 *   every other session's sockets untouched.
 * - `invalidation` (item- or schema-scoped) sends a thin `invalidate` frame only to the sockets of
 *   the user whose write caused it, when the underlying event identifies one — cross-user delivery
 *   is impossible for a REST-driven write. A system/background-triggered write (a rollup recompute,
 *   a mail-sync job, ...) carries no single acting user, so it falls back to every connected
 *   socket. Either way every client refetches the referenced row itself over REST and a client with
 *   nothing cached for it just ignores the frame.
 * - `notification_created` and `notification_read_state` fetch the referenced row(s)' current,
 *   complete state via `getNotificationById` and broadcast a `notification` frame only to sockets
 *   authenticated as that notification's own `userId` — the one place this server sends a full row
 *   rather than a thin reference (a notification's `title` is pre-rendered text with no second
 *   enforcement layer to fall back on).
 *
 * `agent:watch` creates an authorized, cursor-backed subscription: durable events are replayed
 * from `agent_run_events`, then the same subscription receives its thin live references without
 * a handoff gap. Ephemeral typing deltas arrive over the distinct `AGENT_STREAM_CHANNEL` and are
 * sent only to those authorized watchers.
 */
export async function createSyncServer(pool: Pool, options: SyncServerOptions): Promise<SyncServer> {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND_FRAME_BYTES });
  const identityByClient = new WeakMap<WebSocket, SyncIdentity>();
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const agentRunWatch = createAgentRunWatchRegistry(pool);
  let closed = false;

  function attachClient(ws: WebSocket, identity: SyncIdentity): void {
    identityByClient.set(ws, identity);

    // Protocol-v1 frame validation: anything outside the closed catalog is dropped, never
    // crashing this connection or any other client's.
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        parseBinaryFrame(rawDataToBuffer(data));
        return;
      }
      const frame = parseInboundFrame(rawDataToBuffer(data).toString("utf8"));
      if (!frame) return;
      switch (frame.type) {
        case "agent:watch":
          agentRunWatch.watch(ws, identity.userId, frame.runId, frame.afterEventId).catch((err: unknown) => {
            console.error("Sync server failed to watch an agent run", err);
          });
          return;
        case "agent:unwatch":
          agentRunWatch.unwatch(ws, frame.runId);
          return;
        default:
          // doc:open/doc:close are delivered by realtime-v1 issue #162.
          return;
      }
    });

    const heartbeat = setInterval(() => {
      options
        .revalidateSession(identity.sessionId)
        .then((active) => {
          if (!active && ws.readyState === ws.OPEN) ws.close(SESSION_REVOKED_CLOSE_CODE, "session revoked");
        })
        .catch((err: unknown) => {
          console.error("Sync heartbeat session revalidation failed", err);
        });
    }, heartbeatIntervalMs);

    ws.on("close", () => {
      clearInterval(heartbeat);
      identityByClient.delete(ws);
      agentRunWatch.handleSocketClosed(ws);
    });
  }

  const listenClient: PoolClient = await pool.connect();
  try {
    await listenClient.query(`LISTEN ${REALTIME_CHANNEL}`);
    await listenClient.query(`LISTEN ${AGENT_STREAM_CHANNEL}`);
  } catch (err) {
    listenClient.release(true);
    throw err;
  }

  function broadcast(frame: OutboundFrame): void {
    const payload = JSON.stringify(frame);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }

  function sendToUser(userId: string, frame: OutboundFrame): void {
    const payload = JSON.stringify(frame);
    for (const client of wss.clients) {
      const identity = identityByClient.get(client);
      if (identity?.userId === userId && client.readyState === client.OPEN) client.send(payload);
    }
  }

  /**
   * Fetches the current full row for `notificationId` and broadcasts it to `userId`'s sockets —
   * shared by `notification_created` and `notification_read_state`, since both ultimately need the
   * same "here is this notification's current state" frame (a read-state change just carries a
   * non-null `readAt` back).
   */
  async function forwardNotification(userId: string, notificationId: string): Promise<void> {
    const notification = await getNotificationById(pool, notificationId);
    // Already deleted, or the fetch lost a race with a much later state — the next unread-fetch
    // (or active-view refetch) on reconnect still converges the client, so dropping this frame is
    // safe rather than sending a stale/missing row.
    if (!notification) return;
    // Re-check ownership against the fetched row rather than trusting the NOTIFY payload's userId
    // outright — a malformed or tampered payload with a mismatched userId/notificationId pair must
    // never cause cross-user delivery, the same invariant `invalidation`'s actingUserId upholds.
    if (notification.userId !== userId) return;
    sendToUser(userId, { type: "notification", notification });
  }

  let pendingAgentEventDelivery = Promise.resolve();

  function enqueueAgentEvent(runId: string, eventId: string): void {
    const delivery = pendingAgentEventDelivery.then(() => agentRunWatch.forwardEvent(runId, eventId));
    // Keep the serialized queue usable after a failed row fetch, while surfacing the original
    // infrastructure fault rather than pretending the event was forwarded.
    pendingAgentEventDelivery = delivery.catch((err: unknown) => {
      console.error("Sync server failed to forward an agent run event", err);
    });
  }

  const onNotification = (msg: { channel: string; payload?: string }) => {
    if (msg.payload === undefined) return;

    if (msg.channel === AGENT_STREAM_CHANNEL) {
      let rawParsed: unknown;
      try {
        rawParsed = JSON.parse(msg.payload);
      } catch {
        return;
      }
      const parsed = parseAgentStreamMessage(rawParsed);
      if (parsed) agentRunWatch.forwardDelta(parsed);
      return;
    }

    if (msg.channel !== REALTIME_CHANNEL) return;

    let rawParsed: unknown;
    try {
      rawParsed = JSON.parse(msg.payload);
    } catch {
      return;
    }
    const parsed: RealtimeMessage | null = parseRealtimeMessage(rawParsed);
    if (!parsed) return;

    switch (parsed.type) {
      case "session_revoked": {
        const revokedSessionId = parsed.sessionId;
        for (const client of wss.clients) {
          const identity = identityByClient.get(client);
          if (identity?.sessionId === revokedSessionId && client.readyState === client.OPEN) {
            client.close(SESSION_REVOKED_CLOSE_CODE, "session revoked");
          }
        }
        return;
      }
      case "invalidation": {
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
        // Scoped to the acting user's own sockets when the write that caused it identifies one
        // (every REST-driven item/database/property/view write does) — cross-user delivery is
        // impossible for those. A system/background-triggered write (rollup recompute, mail sync,
        // ...) carries no acting user, so it falls back to every socket: there is no user to
        // exclude, and that data is not scoped to one.
        if (parsed.userId) sendToUser(parsed.userId, frame);
        else broadcast(frame);
        return;
      }
      case "notification_created": {
        forwardNotification(parsed.userId, parsed.notificationId).catch((err: unknown) => {
          console.error("Sync server failed to forward a created notification", err);
        });
        return;
      }
      case "notification_read_state": {
        for (const notificationId of parsed.notificationIds) {
          forwardNotification(parsed.userId, notificationId).catch((err: unknown) => {
            console.error("Sync server failed to forward a notification read-state update", err);
          });
        }
        return;
      }
      case "agent_run_event": {
        enqueueAgentEvent(parsed.agentRunId, parsed.eventId);
        return;
      }
      default:
        // doc_update is delivered by realtime-v1 issue #162.
        return;
    }
  };
  listenClient.on("notification", onNotification);

  // Same reasoning as `wsServer.ts`'s `startRealtimeServer`: an unhandled 'error' here would
  // crash the whole process on a dropped LISTEN connection.
  const onError = (err: unknown) => {
    console.error("Sync server LISTEN connection error", err);
  };
  listenClient.on("error", onError);

  return {
    handleUpgrade(req, socket, head) {
      options
        .authenticate(req)
        .then((identity) => {
          if (!identity) {
            rejectUpgrade(socket);
            return;
          }
          // `close()` may have run while this authentication was in flight (a graceful shutdown
          // race): its close-frame loop has already finished, so a client attached now would
          // never receive one, and `wss.close()` would wait on it forever.
          if (closed) {
            rejectUpgrade(socket);
            return;
          }
          wss.handleUpgrade(req, socket, head, (ws) => attachClient(ws, identity));
        })
        .catch((err: unknown) => {
          console.error("Sync upgrade authentication failed", err);
          rejectUpgrade(socket);
        });
    },
    async close() {
      closed = true;
      listenClient.off("notification", onNotification);
      listenClient.off("error", onError);
      // `terminate()`, not `close()`: an unresponsive client (dropped network, crashed tab) would
      // otherwise never complete the close handshake, hanging `wss.close()` below indefinitely.
      for (const client of wss.clients) client.terminate();
      // A client that has issued LISTEN carries session state the pool must not silently
      // reuse — release(true) destroys the underlying connection instead of pooling it.
      listenClient.release(true);
      await new Promise<void>((resolve, reject) => wss.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
