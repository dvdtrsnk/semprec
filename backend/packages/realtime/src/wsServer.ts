import type { Pool, PoolClient } from "pg";
import type { WebSocketServer } from "ws";
import { REALTIME_CHANNEL } from "./pgNotifyPublisher.js";

export interface RealtimeServer {
  close(): Promise<void>;
}

/**
 * Minimal LISTEN/NOTIFY -> WS fan-out (issue #23, point 8): every NOTIFY on
 * `REALTIME_CHANNEL` is broadcast verbatim, as a JSON text frame, to every connected
 * client — no per-client subscription filtering yet, clients filter by `type`/`docId`/
 * `itemId` themselves. Realtime presence/Awareness is deliberately not implemented
 * (see the issue, point 7); when it is, it rides this same channel as another message
 * type, not a new mechanism.
 *
 * The caller owns `wss` (and whatever HTTP server it's attached to) — this function
 * only wires the Postgres side to it.
 */
export async function startRealtimeServer(pool: Pool, wss: WebSocketServer): Promise<RealtimeServer> {
  const listenClient: PoolClient = await pool.connect();
  await listenClient.query(`LISTEN ${REALTIME_CHANNEL}`);

  const onNotification = (msg: { channel: string; payload?: string }) => {
    if (msg.channel !== REALTIME_CHANNEL || msg.payload === undefined) return;
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(msg.payload);
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
      // A client that has issued LISTEN carries session state the pool must not silently
      // reuse — release(true) destroys the underlying connection instead of pooling it.
      listenClient.release(true);
      await new Promise<void>((resolve, reject) => wss.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
