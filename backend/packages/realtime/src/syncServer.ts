import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Pool, PoolClient } from "pg";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { getNotificationById } from "@semprec/data";
import {
  AGENT_STREAM_CHANNEL,
  REALTIME_CHANNEL,
  parseAgentStreamMessage,
  parseRealtimeMessage,
  type RealtimeMessage,
} from "./pgNotifyPublisher.js";
import { createAgentRunWatchRegistry } from "./agentRunWatch.js";
import { createDocSyncRegistry } from "./docSync.js";
import { decodeDocId, parseBinaryFrame, parseInboundFrame, type OutboundFrame } from "./protocolV1.js";
import { sendWithBackpressure } from "./backpressure.js";
import { createInvalidationCoalescer } from "./invalidationCoalescer.js";

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
 * RFC 6455 close code 1012 ("Service Restart"), used for both a LISTEN-connection outage and a
 * controlled process shutdown (issue #242's Task). Neither case has anything to replay — NOTIFY
 * is never persisted — so every affected client is forced through its own resume path rather than
 * left holding a socket this process can no longer serve.
 */
const SERVICE_RESTART_CLOSE_CODE = 1012;

/**
 * Caps every inbound frame at 2 MB (issue #242's Task). `ws`'s own `maxPayload` enforcement closes
 * an over-limit connection automatically (close code 1009) before the frame ever reaches this
 * server's message handler, so one authenticated client can't hold the process's memory hostage
 * with an oversized frame.
 */
const MAX_INBOUND_FRAME_BYTES = 2_000_000;

/** Ping cadence and missed-pong budget (issue #242's Task): closed within ~90s of going unresponsive. */
const MAX_MISSED_PONGS = 2;

/** Base and cap for the LISTEN-connection reconnect backoff after an outage. */
const LISTEN_RECONNECT_BASE_DELAY_MS = 200;
const LISTEN_RECONNECT_MAX_DELAY_MS = 5_000;

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
 * `WS /api/sync` (issue #160/#161/#162): the one authenticated, multiplexed connection every
 * realtime stream rides — one socket per client, associated with a verified user/session identity
 * for its whole lifetime. Owns this process's single dedicated Postgres LISTEN connection on
 * `REALTIME_CHANNEL` and acts on five message kinds from it:
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
 * - `doc_update` fans out to `docSync`, which fetches the referenced `doc_updates` row by primary
 *   key and forwards it only to sockets that have that document open (see `docSync.ts`).
 *
 * `agent:watch` creates an authorized, cursor-backed subscription: durable events are replayed
 * from `agent_run_events`, then the same subscription receives its thin live references without
 * a handoff gap. Ephemeral typing deltas arrive over the distinct `AGENT_STREAM_CHANNEL` and are
 * sent only to those authorized watchers.
 * `doc:open`/`doc:close` text frames and binary y-protocols/sync frames are also handled here, via
 * `docSync` (issue #162).
 */
export async function createSyncServer(pool: Pool, options: SyncServerOptions): Promise<SyncServer> {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND_FRAME_BYTES });
  const identityByClient = new WeakMap<WebSocket, SyncIdentity>();
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const agentRunWatch = createAgentRunWatchRegistry(pool);
  const docSync = createDocSyncRegistry(pool);
  let closed = false;

  const invalidationCoalescer = createInvalidationCoalescer();

  function deliver(client: WebSocket, frame: OutboundFrame): void {
    if (frame.type === "invalidate" && frame.scope === "item") {
      invalidationCoalescer.enqueue(client, frame);
      return;
    }
    sendWithBackpressure(client, JSON.stringify(frame));
  }

  function attachClient(ws: WebSocket, identity: SyncIdentity): void {
    identityByClient.set(ws, identity);

    // `ws` already closes the connection itself for a protocol-level fault (e.g. a frame over
    // `maxPayload`) before emitting this — but it emits it regardless, and an `EventEmitter`
    // with no `'error'` listener throws it as an uncaught exception, which would crash this
    // whole process over one client's malformed frame. Logging here is purely to observe it.
    ws.on("error", (err: unknown) => {
      console.error("Sync server client socket error", err);
    });

    // Protocol-v1 frame validation: anything outside the closed catalog is dropped, never
    // crashing this connection or any other client's. Binary sync-protocol frames are dispatched
    // to `docSync`; agent frames are dispatched to the run-watch registry below.
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        const frame = parseBinaryFrame(rawDataToBuffer(data));
        if (!frame) return;
        const docId = decodeDocId(frame.docId);
        if (!docId) return;
        docSync.handleBinaryFrame(ws, docId, frame.payload).catch((err: unknown) => {
          console.error("Sync server failed to handle a doc binary frame", err);
        });
        return;
      }
      const frame = parseInboundFrame(rawDataToBuffer(data).toString("utf8"));
      if (!frame) return;
      switch (frame.type) {
        case "doc:open":
          docSync.handleOpen(ws, frame.docId).catch((err: unknown) => {
            console.error("Sync server failed to handle doc:open", err);
          });
          return;
        case "doc:close":
          docSync.handleClose(ws, frame.docId);
          return;
        case "agent:watch":
          agentRunWatch.watch(ws, identity.userId, frame.runId, frame.afterEventId).catch((err: unknown) => {
            console.error("Sync server failed to watch an agent run", err);
          });
          return;
        case "agent:unwatch":
          agentRunWatch.unwatch(ws, frame.runId);
          return;
        default:
          return;
      }
    });

    // RFC 6455 protocol-level ping (issue #242's Task): a control frame, not an application
    // message, so a browser or `URLSession` peer answers it on their own without any client-side
    // code. `missedPongs` resets on every pong; a connection that fails to answer this many
    // consecutive pings is presumed dead and dropped without waiting on a close handshake it has
    // already shown it won't complete.
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

      // The fallback for a lost `session_revoked` NOTIFY (issue #160) rides this same tick.
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
      invalidationCoalescer.discard(ws);
      agentRunWatch.handleSocketClosed(ws);
      docSync.handleSocketClosed(ws);
    });
  }

  async function connectListenClient(): Promise<PoolClient> {
    const client = await pool.connect();
    try {
      await client.query(`LISTEN ${REALTIME_CHANNEL}`);
      await client.query(`LISTEN ${AGENT_STREAM_CHANNEL}`);
    } catch (err) {
      client.release(true);
      throw err;
    }
    return client;
  }

  let listenClient: PoolClient = await connectListenClient();
  // Guards against detaching/releasing the same client twice — `onError` and `close()` can both
  // race to clean up the same broken connection.
  let listenClientActive = true;

  function broadcast(frame: OutboundFrame): void {
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) deliver(client, frame);
    }
  }

  function sendToUser(userId: string, frame: OutboundFrame): void {
    for (const client of wss.clients) {
      const identity = identityByClient.get(client);
      if (identity?.userId === userId && client.readyState === client.OPEN) deliver(client, frame);
    }
  }

  /** Closes every currently connected socket with `code`/`reason` — never a per-stream drop. */
  function closeAll(code: number, reason: string): void {
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.close(code, reason);
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

  const agentEventDeliveryTails = new Map<string, { promise: Promise<void> }>();

  function enqueueAgentEvent(runId: string, eventId: string): void {
    const entry = { promise: Promise.resolve() };
    const preceding = agentEventDeliveryTails.get(runId)?.promise ?? Promise.resolve();
    entry.promise = preceding
      .then(() => agentRunWatch.forwardEvent(runId, eventId))
      .catch((err: unknown) => {
        // Keep this run's delivery queue usable after a failed row fetch, without delaying a
        // different run's events or pretending the original infrastructure fault was forwarded.
        console.error("Sync server failed to forward an agent run event", err);
      })
      .then(() => {
        if (agentEventDeliveryTails.get(runId) === entry) agentEventDeliveryTails.delete(runId);
      });
    agentEventDeliveryTails.set(runId, entry);
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
      case "doc_update": {
        docSync.fanOutDocUpdate(parsed.docId, parsed.updateId).catch((err: unknown) => {
          console.error("Sync server failed to fan out a doc update", err);
        });
        return;
      }
      default:
        return;
    }
  };
  function detachListenClient(): void {
    if (!listenClientActive) return;
    listenClientActive = false;
    listenClient.off("notification", onNotification);
    listenClient.off("error", onError);
    listenClient.release(true);
  }

  /**
   * Retries `connectListenClient` with capped exponential backoff until it succeeds or `close()`
   * runs. On success, every connected socket is closed with 1012 exactly as it was when the
   * outage began — a socket that connected during the gap has no way to tell it missed anything,
   * so it goes through the same blunt, uniform resume path as one that was already open.
   */
  async function reconnectListen(): Promise<void> {
    let delay = LISTEN_RECONNECT_BASE_DELAY_MS;
    while (!closed) {
      try {
        const client = await connectListenClient();
        if (closed) {
          // `close()` ran while this attempt was in flight — this client must not become the
          // active `listenClient` after the server already considers itself closed.
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
        console.error("Sync server failed to reconnect its LISTEN connection", err);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, LISTEN_RECONNECT_MAX_DELAY_MS);
      }
    }
  }

  listenClient.on("notification", onNotification);

  // The dedicated LISTEN connection carries no replayable state — NOTIFY is never persisted — so
  // losing it forces every connected socket through its own resume path (issue #242's Task)
  // rather than leaving them attached to a process that can no longer fan anything out to them.
  // An unhandled 'error' here would otherwise crash the whole process on a dropped connection.
  const onError = (err: unknown) => {
    console.error("Sync server LISTEN connection error", err);
    detachListenClient();
    closeAll(SERVICE_RESTART_CLOSE_CODE, "listen connection lost");
    if (!closed) {
      reconnectListen().catch((reconnectErr: unknown) => {
        console.error("Sync server LISTEN reconnect loop failed unexpectedly", reconnectErr);
      });
    }
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
      detachListenClient();
      // A controlled (deploy) shutdown (issue #242's Task) sends every client a real 1012 close
      // frame rather than `terminate()`ing them: the whole point is telling each one "reconnect
      // elsewhere," which only a delivered close code does. This `wss` was created with
      // `noServer: true` and never attached to an `http.Server`, so `wss.close()` below does not
      // wait on these clients finishing their handshake — an unresponsive one is hard-dropped by
      // `ws`'s own close timeout rather than hanging this method.
      closeAll(SERVICE_RESTART_CLOSE_CODE, "server shutting down");
      await new Promise<void>((resolve, reject) => wss.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
