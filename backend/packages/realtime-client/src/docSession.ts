import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync.js";

/**
 * Marks a `Y.applyUpdate` call as originating from the server, not a local edit — `ydoc`'s own
 * `update` listener uses this to avoid echoing a just-applied remote update straight back to the
 * server it came from.
 */
const REMOTE_ORIGIN = Symbol("realtime-client:doc-session:remote-update");

/**
 * One document's client-side half of the y-protocols/sync handshake (issue #164's Task): fed raw
 * binary payloads already stripped of their `WS /api/sync` docId frame prefix by the caller
 * (`syncClient.ts`), and drives `send` with whatever y-protocols/sync response that payload calls
 * for. Reopening the same `docId` after a reconnect — the caller re-sends `doc:open`, the server
 * replies with a fresh SyncStep1 exactly as it does on a first open — re-runs this same handshake
 * from scratch, so a dropped connection's missing updates are recovered the same way a first
 * connection's are, without any separate "resume" code path.
 */
export interface DocSession {
  readonly docId: string;
  readonly ydoc: Y.Doc;
  /** Feeds one binary y-protocols/sync payload for this session's own `docId`. */
  handlePayload(payload: Uint8Array): void;
}

/**
 * `send` transports one y-protocols/sync payload for `docId` back over `WS /api/sync`'s binary
 * channel — `syncClient.ts` owns prefixing it with the 16-byte docId frame and the socket itself.
 * `ydoc` defaults to a fresh, empty document; passing an existing one lets a caller keep editing
 * through a reconnect that replaces the underlying session transport.
 */
export function createDocSession(docId: string, send: (payload: Uint8Array) => void, ydoc: Y.Doc = new Y.Doc()): DocSession {
  ydoc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE_ORIGIN) return;
    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, update);
    send(encoding.toUint8Array(encoder));
  });

  return {
    docId,
    ydoc,
    handlePayload(payload) {
      let decoder: decoding.Decoder;
      let messageType: number;
      try {
        decoder = decoding.createDecoder(payload);
        messageType = decoding.readVarUint(decoder);
      } catch {
        // Malformed payload from this connection's own server — dropped rather than crashing
        // the whole sync client over one document's corrupted frame.
        return;
      }

      switch (messageType) {
        case syncProtocol.messageYjsSyncStep1: {
          let remoteStateVector: Uint8Array;
          try {
            remoteStateVector = decoding.readVarUint8Array(decoder);
          } catch {
            return;
          }
          // Mirrors the server's own handshake (`docSync.ts`): reply with whatever this
          // client has that the server's state vector shows it's missing (SyncStep2), and
          // separately ask for the server's own content via this client's own SyncStep1 — the
          // "reconnect after offline edits exchanges only the necessary Yjs diff" contract,
          // now run identically whether this is the first open or a resume after reconnect.
          const step2Encoder = encoding.createEncoder();
          syncProtocol.writeSyncStep2(step2Encoder, ydoc, remoteStateVector);
          send(encoding.toUint8Array(step2Encoder));

          const step1Encoder = encoding.createEncoder();
          syncProtocol.writeSyncStep1(step1Encoder, ydoc);
          send(encoding.toUint8Array(step1Encoder));
          return;
        }
        case syncProtocol.messageYjsSyncStep2:
        case syncProtocol.messageYjsUpdate: {
          let update: Uint8Array;
          try {
            update = decoding.readVarUint8Array(decoder);
          } catch {
            return;
          }
          // Yjs update application is idempotent, so content this session already has from a
          // prior connection is a no-op rather than a duplicate — "no duplicated or missing
          // information" holds even though reopening always re-runs the full handshake.
          Y.applyUpdate(ydoc, update, REMOTE_ORIGIN);
          return;
        }
        default:
          return;
      }
    },
  };
}
