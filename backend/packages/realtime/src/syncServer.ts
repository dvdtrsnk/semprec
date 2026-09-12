import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Pool, PoolClient } from "pg";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { REALTIME_CHANNEL } from "./pgNotifyPublisher.js";
import { parseBinaryFrame, parseInboundFrame } from "./protocolV1.js";

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
 * `WS /api/sync` (issue #160): the one authenticated, multiplexed connection every realtime
 * stream rides — one socket per client, associated with a verified user/session identity for its
 * whole lifetime. Owns this process's single dedicated Postgres LISTEN connection on
 * `REALTIME_CHANNEL`; the only message kind it acts on here is `session_revoked`, closing every
 * socket authenticated as that exact session with 4401 and leaving every other session's sockets
 * untouched. Actually streaming `invalidate`/`notification`/`agent:event`/`agent:delta` content,
 * and acting on an inbound `doc:open`/`doc:close`/`agent:watch`/`agent:unwatch` frame, is out of
 * this issue's scope — delivered by later realtime-v1 sibling issues on top of this lifecycle.
 */
export async function createSyncServer(pool: Pool, options: SyncServerOptions): Promise<SyncServer> {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND_FRAME_BYTES });
  const identityByClient = new WeakMap<WebSocket, SyncIdentity>();
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  function attachClient(ws: WebSocket, identity: SyncIdentity): void {
    identityByClient.set(ws, identity);

    // Protocol-v1 frame validation: anything outside the closed catalog is dropped, never
    // crashing this connection or any other client's. Acting on a valid frame is out of scope
    // here (see this function's doc comment).
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        parseBinaryFrame(rawDataToBuffer(data));
        return;
      }
      parseInboundFrame(rawDataToBuffer(data).toString("utf8"));
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
    });
  }

  const listenClient: PoolClient = await pool.connect();
  await listenClient.query(`LISTEN ${REALTIME_CHANNEL}`);

  const onNotification = (msg: { channel: string; payload?: string }) => {
    if (msg.channel !== REALTIME_CHANNEL || msg.payload === undefined) return;

    let parsed: { type?: unknown; sessionId?: unknown };
    try {
      parsed = JSON.parse(msg.payload) as { type?: unknown; sessionId?: unknown };
    } catch {
      return;
    }
    if (parsed.type !== "session_revoked" || typeof parsed.sessionId !== "string") return;
    const revokedSessionId = parsed.sessionId;

    for (const client of wss.clients) {
      const identity = identityByClient.get(client);
      if (identity?.sessionId === revokedSessionId && client.readyState === client.OPEN) {
        client.close(SESSION_REVOKED_CLOSE_CODE, "session revoked");
      }
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
          wss.handleUpgrade(req, socket, head, (ws) => attachClient(ws, identity));
        })
        .catch((err: unknown) => {
          console.error("Sync upgrade authentication failed", err);
          rejectUpgrade(socket);
        });
    },
    async close() {
      listenClient.off("notification", onNotification);
      listenClient.off("error", onError);
      for (const client of wss.clients) client.close();
      // A client that has issued LISTEN carries session state the pool must not silently
      // reuse — release(true) destroys the underlying connection instead of pooling it.
      listenClient.release(true);
      await new Promise<void>((resolve, reject) => wss.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
