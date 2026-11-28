import type { Pool } from "pg";
import type { WebSocket } from "ws";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync.js";
import { runInTenant } from "@alldots/shared";
import { getDocById, getDocUpdateById, loadYDoc, mutateYDoc, type CreatedBy } from "@alldots/data";
import { buildBinaryFrame, readClientUpdateId, type OutboundFrame } from "./protocolV1.js";
import { sendWithBackpressure } from "./backpressure.js";
import { logger } from "./logger.js";

/**
 * Updates accepted over the binary channel are attributed to this fixed value, never to anything the client claims; the
 * authenticated origin is the socket's verified identity. Agent and system doc writes go through `createDocStore`'s
 * `origin` parameter instead.
 */
const DOC_SYNC_CREATED_BY: CreatedBy = "user";

/**
 * Per-socket cap on accepted SyncStep2/Update frames, so one socket cannot monopolize the pool with `mutateYDoc`
 * transactions. Extra frames are dropped; the client's Yjs state is untouched, so a later update carries their content.
 */
const MAX_UPDATES_PER_WINDOW = 50;
const RATE_LIMIT_WINDOW_MS = 1000;

/** Bounds one connection's fan-out membership; deliberately low, not a usage expectation. */
const MAX_OPEN_DOCS_PER_CONNECTION = 32;

/**
 * Per-process registry of `doc:open`/`doc:close` subscriptions plus the y-protocols/sync handshake and update
 * persistence. Holds no `Y.Doc` cache: every operation reconstructs from `doc_snapshots`/`doc_updates`, so Postgres is
 * the only source of truth and correctness never depends on which API process a socket landed on.
 */
export interface DocSyncRegistry {
  handleOpen(ws: WebSocket, tenantId: string, docId: string): Promise<void>;
  handleClose(ws: WebSocket, docId: string): void;
  handleSocketClosed(ws: WebSocket): void;
  handleBinaryFrame(ws: WebSocket, tenantId: string, docId: string, payload: Buffer): Promise<void>;
  fanOutDocUpdate(tenantId: string, docId: string, updateId: string): Promise<void>;
}

/** Subscriptions are keyed by tenant as well as document, so one tenant's reference never reaches another's sockets. */
function subscriptionKey(tenantId: string, docId: string): string {
  return `${tenantId}:${docId}`;
}

function sendFrame(ws: WebSocket, docId: string, payload: Uint8Array): void {
  sendWithBackpressure(ws, buildBinaryFrame(docId, payload));
}

export function createDocSyncRegistry(pool: Pool): DocSyncRegistry {
  const subscribersByDoc = new Map<string, Set<WebSocket>>();
  const openDocsByClient = new WeakMap<WebSocket, Set<string>>();
  // A socket stays in one tenant for life; recorded on first open so `handleClose`/`handleSocketClosed` can find the
  // key.
  const tenantByClient = new WeakMap<WebSocket, string>();
  const updateRateByClient = new WeakMap<WebSocket, { count: number; windowStart: number }>();

  function isRateLimited(ws: WebSocket): boolean {
    const now = Date.now();
    const state = updateRateByClient.get(ws);
    if (!state || now - state.windowStart >= RATE_LIMIT_WINDOW_MS) {
      updateRateByClient.set(ws, { count: 1, windowStart: now });
      return false;
    }
    state.count += 1;
    if (state.count === MAX_UPDATES_PER_WINDOW + 1) {
      logger.warn("Sync server dropped a doc update: socket exceeded the per-second rate limit");
    }
    return state.count > MAX_UPDATES_PER_WINDOW;
  }

  function subscribe(ws: WebSocket, tenantId: string, docId: string): void {
    const key = subscriptionKey(tenantId, docId);
    let subscribers = subscribersByDoc.get(key);
    if (!subscribers) {
      subscribers = new Set();
      subscribersByDoc.set(key, subscribers);
    }
    subscribers.add(ws);

    let openDocs = openDocsByClient.get(ws);
    if (!openDocs) {
      openDocs = new Set();
      openDocsByClient.set(ws, openDocs);
    }
    openDocs.add(docId);
  }

  function unsubscribe(ws: WebSocket, docId: string): void {
    const tenantId = tenantByClient.get(ws);
    const key = tenantId === undefined ? undefined : subscriptionKey(tenantId, docId);
    const subscribers = key === undefined ? undefined : subscribersByDoc.get(key);
    if (key !== undefined && subscribers) {
      subscribers.delete(ws);
      if (subscribers.size === 0) subscribersByDoc.delete(key);
    }
    openDocsByClient.get(ws)?.delete(docId);
  }

  /**
   * Reserves `docId` against the cap synchronously: concurrent `doc:open` frames would otherwise all read the same
   * stale count after `getDocById`. Returns `false` when the cap is hit; the caller must undo a fresh reservation if
   * the doc does not exist. A reservation authorizes nothing; `handleBinaryFrame` accepts frames only after
   * `subscribe`.
   */
  function reserveOpenSlot(ws: WebSocket, docId: string): boolean {
    let openDocs = openDocsByClient.get(ws);
    if (openDocs?.has(docId)) return true;
    if ((openDocs?.size ?? 0) >= MAX_OPEN_DOCS_PER_CONNECTION) return false;
    if (!openDocs) {
      openDocs = new Set();
      openDocsByClient.set(ws, openDocs);
    }
    openDocs.add(docId);
    return true;
  }

  return {
    async handleOpen(ws, tenantId, docId) {
      // Enforced before any `await`; see `reserveOpenSlot`.
      if (!reserveOpenSlot(ws, docId)) {
        logger.warn("Sync server rejected doc:open: socket exceeded the per-connection subscription limit");
        return;
      }

      // An unknown docId (or another tenant's, invisible under RLS) is dropped and its reservation released.
      const doc = await runInTenant(tenantId, () => getDocById(pool, docId));
      if (!doc) {
        openDocsByClient.get(ws)?.delete(docId);
        return;
      }

      // The socket may have closed during the query, after its `handleSocketClosed` found nothing to clean up;
      // subscribing now would leak it in `subscribersByDoc`. No `await` follows before `subscribe`.
      if (ws.readyState !== ws.OPEN) {
        openDocsByClient.get(ws)?.delete(docId);
        return;
      }

      tenantByClient.set(ws, tenantId);
      subscribe(ws, tenantId, docId);

      // As y-websocket's reference server: send our SyncStep1 immediately on open, so a client with offline edits
      // replies with a SyncStep2 carrying only what the server is missing.
      const ydoc = await runInTenant(tenantId, () => loadYDoc(pool, docId));
      const encoder = encoding.createEncoder();
      syncProtocol.writeSyncStep1(encoder, ydoc);
      sendFrame(ws, docId, encoding.toUint8Array(encoder));
    },

    handleClose(ws, docId) {
      unsubscribe(ws, docId);
    },

    handleSocketClosed(ws) {
      const openDocs = openDocsByClient.get(ws);
      if (!openDocs) return;
      // `unsubscribe` drops emptied `subscribersByDoc` entries; copy `openDocs` first because it mutates the set.
      for (const docId of [...openDocs]) {
        unsubscribe(ws, docId);
      }
      openDocsByClient.delete(ws);
    },

    async handleBinaryFrame(ws, tenantId, docId, payload) {
      // Binary frames are accepted only for a document subscribed under `tenantId`, not merely reserved: a reservation
      // is taken before the tenant-scoped `getDocById` resolves, so a frame sent meanwhile could target a doc the
      // tenant cannot see. The dropped frame's content reaches the server through the client's reply to the later
      // SyncStep1.
      if (!subscribersByDoc.get(subscriptionKey(tenantId, docId))?.has(ws)) return;

      let decoder: decoding.Decoder;
      let messageType: number;
      try {
        decoder = decoding.createDecoder(payload);
        messageType = decoding.readVarUint(decoder);
      } catch {
        return;
      }

      switch (messageType) {
        case syncProtocol.messageYjsSyncStep1: {
          let clientStateVector: Uint8Array;
          try {
            clientStateVector = decoding.readVarUint8Array(decoder);
          } catch {
            return;
          }
          // Compaction only merges content forward, so any client state vector yields a correct diff against the full
          // doc.
          const ydoc = await runInTenant(tenantId, () => loadYDoc(pool, docId));
          const encoder = encoding.createEncoder();
          syncProtocol.writeSyncStep2(encoder, ydoc, clientStateVector);
          sendFrame(ws, docId, encoding.toUint8Array(encoder));
          return;
        }
        case syncProtocol.messageYjsSyncStep2:
        case syncProtocol.messageYjsUpdate: {
          if (isRateLimited(ws)) return;
          let update: Uint8Array;
          try {
            update = decoding.readVarUint8Array(decoder);
          } catch {
            return;
          }
          // Absent or invalid means stored but never acknowledged.
          const clientUpdateId = readClientUpdateId(decoder);
          // `mutateYDoc` persists the diff as a `doc_updates` row before the after-commit NOTIFY that `fanOutDocUpdate`
          // reacts to. A known or no-op update writes no row and no NOTIFY, so duplicates are idempotent.
          await runInTenant(tenantId, () =>
            mutateYDoc(pool, docId, DOC_SYNC_CREATED_BY, (ydoc) => {
              Y.applyUpdate(ydoc, update, DOC_SYNC_CREATED_BY);
            }),
          );
          // Reached only after the transaction committed; a replay that added nothing is durable too, so it is
          // acknowledged.
          if (clientUpdateId !== null) {
            const ack: OutboundFrame = { type: "doc:ack", docId, clientUpdateId };
            sendWithBackpressure(ws, JSON.stringify(ack));
          }
          return;
        }
        default:
          // Outside the y-protocols/sync catalog (e.g. awareness on the wrong channel): dropped.
          return;
      }
    },

    async fanOutDocUpdate(tenantId, docId, updateId) {
      const subscribers = subscribersByDoc.get(subscriptionKey(tenantId, docId));
      if (!subscribers || subscribers.size === 0) return;

      const updateBytes = await runInTenant(tenantId, () => getDocUpdateById(pool, docId, updateId));
      const encoder = encoding.createEncoder();
      if (updateBytes) {
        syncProtocol.writeUpdate(encoder, updateBytes);
      } else {
        // A concurrent compaction already merged and deleted the row. `doc_snapshots` still holds its content, so send
        // a full resync instead; applying it is a no-op for a subscriber that already had it.
        const ydoc = await runInTenant(tenantId, () => loadYDoc(pool, docId));
        syncProtocol.writeSyncStep2(encoder, ydoc);
      }
      const frame = buildBinaryFrame(docId, encoding.toUint8Array(encoder));

      for (const client of subscribers) {
        sendWithBackpressure(client, frame);
      }
    },
  };
}
