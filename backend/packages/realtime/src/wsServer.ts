import type { IncomingMessage } from "node:http";
import type { Pool, PoolClient } from "pg";
import type { WebSocket, WebSocketServer } from "ws";
import { REALTIME_CHANNEL } from "./pgNotifyPublisher.js";

export interface RealtimeServer {
  close(): Promise<void>;
}

export interface RealtimeServerOptions {
  /**
   * Identifies the user (if any) a newly connected socket belongs to, e.g. by verifying a
   * session token carried on the upgrade request. Every message published with a `userId` field
   * (issue #152's `notification_created`/`notification_read_state`) is then only forwarded to
   * sockets this resolved to that same user — a socket this resolves to `null` never receives one.
   * Messages with no `userId` field (`item_invalidation`, `doc_update`, `agent_run_event`) are
   * unaffected and keep broadcasting to every connected client, same as before this option existed.
   *
   * When `resolveUserId` is omitted entirely, this server has no per-user identity information at
   * all, so it falls back to the pre-#152 default and broadcasts every message — including
   * user-scoped `notification_created`/`notification_read_state` frames — to every connected
   * client. To suppress user-scoped messages for unauthenticated or unrecognized connections,
   * supply this option and resolve to `null` for them.
   *
   * Kept as a caller-supplied hook rather than baked-in auth so this stays the "adapter" issue
   * #152 asks to keep separable — whichever service wires up the live WS upgrade route (absorbed
   * later by #38's full multiplexed protocol) supplies its own real session verification here.
   */
  resolveUserId?: (req: IncomingMessage) => Promise<string | null>;
}

/**
 * Minimal LISTEN/NOTIFY -> WS fan-out (issue #23, point 8): every NOTIFY on
 * `REALTIME_CHANNEL` is broadcast verbatim, as a JSON text frame, to every connected
 * client — no per-client subscription filtering yet, clients filter by `type`/`docId`/
 * `itemId` themselves. Realtime presence/Awareness is deliberately not implemented
 * (see the issue, point 7); when it is, it rides this same channel as another message
 * type, not a new mechanism.
 *
 * `options.resolveUserId` (issue #152) layers the one exception onto that "broadcast to
 * everyone" default: a message carrying a `userId` is scoped to that user's own sockets.
 *
 * The caller owns `wss` (and whatever HTTP server it's attached to) — this function
 * only wires the Postgres side to it.
 */
export async function startRealtimeServer(
  pool: Pool,
  wss: WebSocketServer,
  options: RealtimeServerOptions = {},
): Promise<RealtimeServer> {
  const listenClient: PoolClient = await pool.connect();
  await listenClient.query(`LISTEN ${REALTIME_CHANNEL}`);

  const { resolveUserId } = options;
  // Holds the in-flight (then settled) identity lookup per socket, not just its resolved value:
  // a `notification_created`/`notification_read_state` message that arrives while `resolveUserId`
  // is still running for a just-opened socket must wait for that same lookup to settle before this
  // server decides whether to deliver to it, or it would wrongly treat the socket as unidentified
  // and silently drop the message (see issue #152's PR review, the resolveUserId race finding).
  const identityByClient = new WeakMap<WebSocket, Promise<string | null>>();

  const onConnection = (ws: WebSocket, req: IncomingMessage) => {
    if (!resolveUserId) return;
    const identity = resolveUserId(req).catch((err: unknown) => {
      console.error("Realtime resolveUserId failed for a new connection", err);
      return null;
    });
    identityByClient.set(ws, identity);
  };
  wss.on("connection", onConnection);

  const onNotification = (msg: { channel: string; payload?: string }) => {
    if (msg.channel !== REALTIME_CHANNEL || msg.payload === undefined) return;
    const payload = msg.payload;

    // Only a message carrying `userId` is user-scoped; anything else (or any message at all when
    // no `resolveUserId` was supplied) keeps the original broadcast-to-everyone behavior.
    let targetUserId: string | undefined;
    if (resolveUserId) {
      try {
        const parsed = JSON.parse(payload) as { userId?: unknown };
        if (typeof parsed.userId === "string") targetUserId = parsed.userId;
      } catch {
        // Not JSON, or JSON without a usable `userId` — fall through to a plain broadcast.
      }
    }

    if (targetUserId === undefined) {
      for (const client of wss.clients) {
        if (client.readyState === client.OPEN) client.send(payload);
      }
      return;
    }

    for (const client of wss.clients) {
      if (client.readyState !== client.OPEN) continue;
      const identity = identityByClient.get(client);
      Promise.resolve(identity)
        .then((userId) => {
          if (userId === targetUserId && client.readyState === client.OPEN) client.send(payload);
        })
        .catch((err: unknown) => {
          console.error("Realtime notification delivery failed while awaiting resolveUserId", err);
        });
    }
  };
  listenClient.on("notification", onNotification);

  // A dedicated LISTEN connection dropping (network blip, Postgres restart) emits
  // 'error' on this PoolClient; with no listener, Node treats it as an unhandled
  // EventEmitter error and crashes the whole process. Logging it here just stops fan-out
  // until the process is restarted — reconnect/supervisor logic is a later concern.
  const onError = (err: unknown) => {
    console.error("Realtime LISTEN connection error", err);
  };
  listenClient.on("error", onError);

  return {
    async close() {
      listenClient.off("notification", onNotification);
      listenClient.off("error", onError);
      wss.off("connection", onConnection);
      // A client that has issued LISTEN carries session state the pool must not silently
      // reuse — release(true) destroys the underlying connection instead of pooling it.
      listenClient.release(true);
      await new Promise<void>((resolve, reject) => wss.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
