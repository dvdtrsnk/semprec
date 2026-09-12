import type { Pool } from "pg";
import type { WebSocket } from "ws";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync.js";
import { getDocById, getDocUpdateById, loadYDoc, mutateYDoc, type CreatedBy } from "@semprec/data";
import { buildBinaryFrame } from "./protocolV1.js";

/**
 * Every update accepted over `WS /api/sync`'s binary channel is attributed to this fixed
 * `created_by` value, not to anything the client's message itself claims — the "authenticated
 * origin" the issue's Task asks for is the socket's verified identity (it got this far only
 * because `SyncServerOptions.authenticate` accepted it), never client-supplied data. Agent- or
 * system-originated doc writes go through `createDocStore`'s own `origin` parameter directly,
 * not this WS path.
 */
const DOC_SYNC_CREATED_BY: CreatedBy = "user";

/**
 * Per-socket cap on accepted SyncStep2/Update frames: a legitimately authenticated socket
 * could otherwise send updates fast enough to monopolize the Postgres connection pool with
 * `mutateYDoc` transactions, degrading every other document on this process. A frame beyond
 * the cap is dropped (never queued or buffered) — the client's own Yjs state is untouched, so
 * a later accepted update still carries everything a dropped one would have.
 */
const MAX_UPDATES_PER_WINDOW = 50;
const RATE_LIMIT_WINDOW_MS = 1000;

/**
 * Per-process registry of which open `WS /api/sync` sockets have which documents open
 * (issue #162's `doc:open`/`doc:close` subscription state) plus the y-protocols/sync
 * handshake and update persistence those subscriptions ride on.
 *
 * Deliberately holds no `Y.Doc` cache: every open/update/fan-out below reconstructs the
 * document fresh from `doc_snapshots`/`doc_updates` via `loadYDoc`/`mutateYDoc` (the same
 * primitives `createDocStore` uses), the same "no server-side cache, Postgres is the only
 * source of truth" discipline the rest of the doc-persistence layer already follows — this
 * also means correctness never depends on which of several API processes a socket landed on.
 */
export interface DocSyncRegistry {
  /** A client opened `docId`: subscribes the socket and sends it the server's SyncStep1. */
  handleOpen(ws: WebSocket, docId: string): Promise<void>;
  /** A client closed `docId`: unsubscribes the socket from just that document. */
  handleClose(ws: WebSocket, docId: string): void;
  /** The socket itself closed: unsubscribes it from every document it had open. */
  handleSocketClosed(ws: WebSocket): void;
  /** A binary frame for `docId` arrived from `ws`: parses and acts on its y-protocols/sync message. */
  handleBinaryFrame(ws: WebSocket, docId: string, payload: Buffer): Promise<void>;
  /** A `doc_update` NOTIFY was received for `docId`/`updateId`: fans it out to every open subscriber. */
  fanOutDocUpdate(docId: string, updateId: string): Promise<void>;
}

function sendFrame(ws: WebSocket, docId: string, payload: Uint8Array): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(buildBinaryFrame(docId, payload));
}

export function createDocSyncRegistry(pool: Pool): DocSyncRegistry {
  const subscribersByDoc = new Map<string, Set<WebSocket>>();
  const openDocsByClient = new WeakMap<WebSocket, Set<string>>();
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
      console.warn("Sync server dropped a doc update: socket exceeded the per-second rate limit");
    }
    return state.count > MAX_UPDATES_PER_WINDOW;
  }

  function subscribe(ws: WebSocket, docId: string): void {
    let subscribers = subscribersByDoc.get(docId);
    if (!subscribers) {
      subscribers = new Set();
      subscribersByDoc.set(docId, subscribers);
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
    const subscribers = subscribersByDoc.get(docId);
    if (subscribers) {
      subscribers.delete(ws);
      if (subscribers.size === 0) subscribersByDoc.delete(docId);
    }
    openDocsByClient.get(ws)?.delete(docId);
  }

  return {
    async handleOpen(ws, docId) {
      // A docId naming no real `docs` row (deleted, never existed, malformed-but-UUID-shaped)
      // is dropped rather than opened — there is nothing to sync and no snapshot to read.
      const doc = await getDocById(pool, docId);
      if (!doc) return;

      // The socket may have closed while the query above was in flight — its own `close`
      // handler already ran `handleSocketClosed`, which found no subscription yet and did
      // nothing. Subscribing now, after that, would leave a dead socket permanently held by
      // `subscribersByDoc` with no future close event left to clean it up. No `await` follows
      // this check before `subscribe`, so nothing can close the socket in between.
      if (ws.readyState !== ws.OPEN) return;

      subscribe(ws, docId);

      // Same handshake `y-websocket`'s reference server implementation uses: send this
      // process's own SyncStep1 (its current state vector, reconstructed from
      // `doc_snapshots` + any still-pending `doc_updates`) immediately on open/reconnect,
      // rather than waiting for the client's own SyncStep1 first. A client with edits made
      // while offline replies with SyncStep2 carrying only what this server is missing —
      // the "reconnect after offline edits exchanges only the necessary Yjs diff" acceptance
      // criterion — and a client with nothing new simply has nothing to reply with.
      const ydoc = await loadYDoc(pool, docId);
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
      // `unsubscribe` (not an inline delete) so an emptied `subscribersByDoc` entry is dropped
      // here exactly as it is on an explicit `doc:close` — otherwise a doc whose last subscriber
      // disconnects via socket close, rather than `doc:close`, leaves a permanently empty `Set`
      // behind. Copy `openDocs` first: `unsubscribe` mutates the very set being iterated.
      for (const docId of [...openDocs]) {
        unsubscribe(ws, docId);
      }
      openDocsByClient.delete(ws);
    },

    async handleBinaryFrame(ws, docId, payload) {
      // A socket must have opened this document before this server accepts binary frames for
      // it — mirrors the closed-catalog validation the rest of protocol-v1 already applies,
      // and is what makes "an unsubscribed client receives none" also true for what this
      // server is willing to persist, not just what it forwards.
      if (!openDocsByClient.get(ws)?.has(docId)) return;

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
          // Diffed against the full current doc (`doc_snapshots` merged with any still-pending
          // `doc_updates`) — a client's state vector always yields a correct SyncStep2 diff
          // against this, regardless of how stale it is or how many compactions have run since,
          // because compaction only ever merges retained content forward, never discards it.
          const ydoc = await loadYDoc(pool, docId);
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
          // `mutateYDoc` loads the current doc, applies `update` inside a transaction, and
          // persists the resulting diff as a new `doc_updates` row (mirrored into
          // `doc_history_updates`) before firing the after-commit NOTIFY this same registry's
          // `fanOutDocUpdate` reacts to — the "persist before transactional NOTIFY" ordering the
          // issue's Task asks for is inherited from that existing write path rather than
          // reimplemented here. An already-known or no-op update produces no new row and no
          // NOTIFY, preserving idempotence for a duplicate or replayed frame.
          await mutateYDoc(pool, docId, DOC_SYNC_CREATED_BY, (ydoc) => {
            Y.applyUpdate(ydoc, update, DOC_SYNC_CREATED_BY);
          });
          return;
        }
        default:
          // Outside the closed y-protocols/sync catalog (e.g. an awareness message riding the
          // wrong channel) — dropped, never crashing this connection or any other client's.
          return;
      }
    },

    async fanOutDocUpdate(docId, updateId) {
      const subscribers = subscribersByDoc.get(docId);
      if (!subscribers || subscribers.size === 0) return;

      const updateBytes = await getDocUpdateById(pool, updateId);
      const encoder = encoding.createEncoder();
      if (updateBytes) {
        syncProtocol.writeUpdate(encoder, updateBytes);
      } else {
        // The referenced `doc_updates` row is already gone — a concurrent compaction merged it
        // into `doc_snapshots` and deleted it before this fetch ran. Recovering by sending the
        // full current state (a SyncStep2 diff against an empty state vector) rather than
        // dropping the frame is exactly the retained-snapshot recovery the issue's Task asks
        // for: `doc_snapshots` still holds everything the deleted row contributed, so no
        // subscriber silently misses the change — it just receives it folded into a full resync
        // instead of as one incremental update. Yjs's update application is idempotent, so a
        // subscriber that already had this content applies a no-op.
        const ydoc = await loadYDoc(pool, docId);
        syncProtocol.writeSyncStep2(encoder, ydoc);
      }
      const frame = buildBinaryFrame(docId, encoding.toUint8Array(encoder));

      for (const client of subscribers) {
        if (client.readyState === client.OPEN) client.send(frame);
      }
    },
  };
}
