import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync.js";

/** Origin of a remote `Y.applyUpdate`, so the `update` listener does not echo it back to the server. */
const REMOTE_ORIGIN = Symbol("realtime-client:doc-session:remote-update");

/**
 * One document's client half of the y-protocols/sync handshake, fed binary payloads with the docId
 * prefix already stripped by `syncClient.ts`. Reopening after a reconnect re-runs the full
 * handshake, which also recovers updates missed while disconnected; there is no separate resume path.
 */
export interface DocSession {
  readonly docId: string;
  readonly ydoc: Y.Doc;
  /** Feeds one binary y-protocols/sync payload for this session's own `docId`. */
  handlePayload(payload: Uint8Array): void;
  /**
   * Detaches the `ydoc` update listener. Required before a retained `ydoc` is reused in another
   * `createDocSession`, or every local edit is sent twice.
   */
  dispose(): void;
}

/**
 * `send` carries one sync payload back over `WS /api/sync` (`syncClient.ts` adds the 16-byte docId
 * prefix). Passing an existing `ydoc` lets a caller keep editing across a reconnect.
 */
export function createDocSession(
  docId: string,
  send: (payload: Uint8Array) => void,
  ydoc: Y.Doc = new Y.Doc(),
): DocSession {
  const onUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === REMOTE_ORIGIN) return;
    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, update);
    send(encoding.toUint8Array(encoder));
  };
  ydoc.on("update", onUpdate);

  return {
    docId,
    ydoc,
    dispose() {
      ydoc.off("update", onUpdate);
    },
    handlePayload(payload) {
      let decoder: decoding.Decoder;
      let messageType: number;
      try {
        decoder = decoding.createDecoder(payload);
        messageType = decoding.readVarUint(decoder);
      } catch (err) {
        // A malformed frame is dropped rather than crashing the whole sync client.
        console.warn(`docSession(${docId}): malformed binary frame header, dropping`, err);
        return;
      }

      switch (messageType) {
        case syncProtocol.messageYjsSyncStep1: {
          let remoteStateVector: Uint8Array;
          try {
            remoteStateVector = decoding.readVarUint8Array(decoder);
          } catch (err) {
            console.warn(`docSession(${docId}): malformed SyncStep1 state vector, dropping`, err);
            return;
          }
          // Mirrors the server's handshake (`docSync.ts`): reply with what the server's state vector lacks (SyncStep2)
          // and ask for the server's content with our own SyncStep1, on first open and on resume alike.
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
          } catch (err) {
            console.warn(`docSession(${docId}): malformed sync update payload, dropping`, err);
            return;
          }
          // Yjs update application is idempotent, so content already held from a prior connection is a no-op.
          Y.applyUpdate(ydoc, update, REMOTE_ORIGIN);
          return;
        }
        default:
          return;
      }
    },
  };
}
