import type { Pool } from "pg";
import type { WebSocket } from "ws";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync.js";
import { runInTenant } from "@semprec/shared";
import { getDocById, getDocUpdateById, loadYDoc, mutateYDoc, type CreatedBy } from "@semprec/data";
import { buildBinaryFrame } from "./protocolV1.js";
import { sendWithBackpressure } from "./backpressure.js";

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
 * Per-connection cap on distinct open documents (issue #242's Task): a client that opened this
 * many documents already gets no more subscriptions from this socket until it closes one. Kept
 * deliberately low relative to any real editor's working set, since it exists only to bound one
 * connection's fan-out membership, not to reflect an expected usage pattern.
 */
const MAX_OPEN_DOCS_PER_CONNECTION = 32;

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
  /** A client of `tenantId` opened `docId`: subscribes the socket and sends it the server's SyncStep1. */
  handleOpen(ws: WebSocket, tenantId: string, docId: string): Promise<void>;
  /** A client closed `docId`: unsubscribes the socket from just that document. */
  handleClose(ws: WebSocket, docId: string): void;
  /** The socket itself closed: unsubscribes it from every document it had open. */
  handleSocketClosed(ws: WebSocket): void;
  /** A binary frame for `docId` arrived from `ws`: parses and acts on its y-protocols/sync message. */
  handleBinaryFrame(ws: WebSocket, tenantId: string, docId: string, payload: Buffer): Promise<void>;
  /** A `doc_update` NOTIFY was received for `docId`/`updateId`: fans it out to every open subscriber. */
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
  // A socket is authenticated in exactly one tenant for its whole life; recorded on first open so
  // `handleClose`/`handleSocketClosed` (which take no tenant) find the subscription key.
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
      console.warn("Sync server dropped a doc update: socket exceeded the per-second rate limit");
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
   * Reserves `docId` against the per-connection cap synchronously, before any `await` — a burst
   * of concurrent `doc:open` frames dispatches each one's async body without waiting for the
   * previous to finish, so checking the cap only after `getDocById` resolves would let every
   * frame in the burst read the same stale (pre-mutation) count and all pass it. Returns `false`
   * (cap already hit) or `true` (already open, or newly reserved) — the caller must undo a fresh
   * reservation if the doc turns out not to exist. A reservation only counts against the cap; it
   * authorizes nothing — `handleBinaryFrame` accepts frames only once `subscribe` has run.
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
      // The per-connection subscription cap (issue #242's Task) is enforced synchronously,
      // before any `await` below, precisely so a burst of concurrent `doc:open` frames for
      // distinct docs can't all read the same stale count and land at 33 (see
      // `reserveOpenSlot`'s doc comment).
      if (!reserveOpenSlot(ws, docId)) {
        console.warn("Sync server rejected doc:open: socket exceeded the per-connection subscription limit");
        return;
      }

      // A docId naming no real `docs` row (deleted, never existed, malformed-but-UUID-shaped)
      // is dropped rather than opened — there is nothing to sync and no snapshot to read. The
      // reservation above is released so a bad docId never permanently occupies a cap slot.
      // Resolved inside the socket's tenant: another tenant's doc is invisible under RLS, so it
      // takes this same path as a nonexistent id.
      const doc = await runInTenant(tenantId, () => getDocById(pool, docId));
      if (!doc) {
        openDocsByClient.get(ws)?.delete(docId);
        return;
      }

      // The socket may have closed while the query above was in flight — its own `close`
      // handler already ran `handleSocketClosed`, which found no subscription yet and did
      // nothing. Subscribing now, after that, would leave a dead socket permanently held by
      // `subscribersByDoc` with no future close event left to clean it up. No `await` follows
      // this check before `subscribe`, so nothing can close the socket in between.
      if (ws.readyState !== ws.OPEN) {
        openDocsByClient.get(ws)?.delete(docId);
        return;
      }

      tenantByClient.set(ws, tenantId);
      subscribe(ws, tenantId, docId);

      // Same handshake `y-websocket`'s reference server implementation uses: send this
      // process's own SyncStep1 (its current state vector, reconstructed from
      // `doc_snapshots` + any still-pending `doc_updates`) immediately on open/reconnect,
      // rather than waiting for the client's own SyncStep1 first. A client with edits made
      // while offline replies with SyncStep2 carrying only what this server is missing —
      // the "reconnect after offline edits exchanges only the necessary Yjs diff" acceptance
      // criterion — and a client with nothing new simply has nothing to reply with.
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
      // `unsubscribe` (not an inline delete) so an emptied `subscribersByDoc` entry is dropped
      // here exactly as it is on an explicit `doc:close` — otherwise a doc whose last subscriber
      // disconnects via socket close, rather than `doc:close`, leaves a permanently empty `Set`
      // behind. Copy `openDocs` first: `unsubscribe` mutates the very set being iterated.
      for (const docId of [...openDocs]) {
        unsubscribe(ws, docId);
      }
      openDocsByClient.delete(ws);
    },

    async handleBinaryFrame(ws, tenantId, docId, payload) {
      // A socket must have opened this document before this server accepts binary frames for
      // it — mirrors the closed-catalog validation the rest of protocol-v1 already applies,
      // and is what makes "an unsubscribed client receives none" also true for what this
      // server is willing to persist, not just what it forwards. The gate is the subscription
      // under `tenantId`, not the `openDocsByClient` reservation: a reservation is taken before
      // `handleOpen`'s tenant-scoped `getDocById` resolves, so a frame sent while that lookup is
      // still pending (e.g. right after a `doc:open` for another tenant's doc) would otherwise be
      // accepted for a doc the socket's tenant cannot see. Such an early frame is dropped; the
      // client's own Yjs state keeps its content, and its reply to the SyncStep1 `handleOpen`
      // sends once the open is confirmed carries it.
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
          // Diffed against the full current doc (`doc_snapshots` merged with any still-pending
          // `doc_updates`) — a client's state vector always yields a correct SyncStep2 diff
          // against this, regardless of how stale it is or how many compactions have run since,
          // because compaction only ever merges retained content forward, never discards it.
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
          // `mutateYDoc` loads the current doc, applies `update` inside a transaction, and
          // persists the resulting diff as a new `doc_updates` row (mirrored into
          // `doc_history_updates`) before firing the after-commit NOTIFY this same registry's
          // `fanOutDocUpdate` reacts to — the "persist before transactional NOTIFY" ordering the
          // issue's Task asks for is inherited from that existing write path rather than
          // reimplemented here. An already-known or no-op update produces no new row and no
          // NOTIFY, preserving idempotence for a duplicate or replayed frame.
          await runInTenant(tenantId, () =>
            mutateYDoc(pool, docId, DOC_SYNC_CREATED_BY, (ydoc) => {
              Y.applyUpdate(ydoc, update, DOC_SYNC_CREATED_BY);
            }),
          );
          return;
        }
        default:
          // Outside the closed y-protocols/sync catalog (e.g. an awareness message riding the
          // wrong channel) — dropped, never crashing this connection or any other client's.
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
        // The referenced `doc_updates` row is already gone — a concurrent compaction merged it
        // into `doc_snapshots` and deleted it before this fetch ran. Recovering by sending the
        // full current state (a SyncStep2 diff against an empty state vector) rather than
        // dropping the frame is exactly the retained-snapshot recovery the issue's Task asks
        // for: `doc_snapshots` still holds everything the deleted row contributed, so no
        // subscriber silently misses the change — it just receives it folded into a full resync
        // instead of as one incremental update. Yjs's update application is idempotent, so a
        // subscriber that already had this content applies a no-op.
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
