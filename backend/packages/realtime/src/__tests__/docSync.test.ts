import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createChokePoint, createDocStore, loadYDoc, type ChokePoint, type DocStore } from "@semprec/data";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createDocSyncRegistry, type DocSyncRegistry } from "../docSync.js";
import { decodeDocId, parseBinaryFrame } from "../protocolV1.js";

let pool: Pool;

afterAll(async () => {
  await pool?.end();
});

/** A minimal stand-in for `ws.WebSocket` — just enough surface for `DocSyncRegistry` to use. */
class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Buffer[] = [];
  send(data: Buffer): void {
    this.sent.push(data);
  }
}

function lastFramePayload(socket: FakeSocket, docId: string): Buffer {
  for (let i = socket.sent.length - 1; i >= 0; i--) {
    const frame = parseBinaryFrame(socket.sent[i]!);
    if (frame && decodeDocId(frame.docId) === docId) return frame.payload;
  }
  throw new Error("expected a frame for this docId");
}

function encodeClientSyncStep1(ydoc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  syncProtocol.writeSyncStep1(encoder, ydoc);
  return encoding.toUint8Array(encoder);
}

function encodeClientUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

/** Applies a received sync-step-1/2/update payload to `ydoc`, mirroring a real client. */
function applyServerPayload(ydoc: Y.Doc, payload: Buffer): void {
  const decoder = decoding.createDecoder(payload);
  const messageType = decoding.readVarUint(decoder);
  if (messageType === syncProtocol.messageYjsSyncStep1) {
    decoding.readVarUint8Array(decoder); // the server's state vector — unused by this helper
    return;
  }
  const update = decoding.readVarUint8Array(decoder);
  Y.applyUpdate(ydoc, update);
}

describe("createDocSyncRegistry (issue #162)", () => {
  let chokePoint: ChokePoint;
  let docStore: DocStore;
  let registry: DocSyncRegistry;
  let docId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    chokePoint = createChokePoint(pool);
    docStore = createDocStore(pool);
    registry = createDocSyncRegistry(pool);

    const db = await chokePoint.createDatabase({ name: "Pages" });
    const item = await chokePoint.createItem({ databaseId: db.id, properties: {} });
    await docStore.putBlock(item.id, { id: "root", flavour: "page" }, "user");
    const doc = await docStore.getDoc(item.id);
    docId = doc!.id;
  });

  it("drops a doc:open for a docId naming no real docs row", async () => {
    const socket = new FakeSocket();
    await registry.handleOpen(socket as unknown as never, "00000000-0000-0000-0000-000000000000");
    expect(socket.sent).toHaveLength(0);
  });

  it("sends the server's SyncStep1 on open, and fans an accepted update out only to sockets with the doc open", async () => {
    const subscribed = new FakeSocket();
    const unsubscribed = new FakeSocket();
    await registry.handleOpen(subscribed as unknown as never, docId);
    await registry.handleOpen(unsubscribed as unknown as never, docId);
    registry.handleClose(unsubscribed as unknown as never, docId);

    expect(subscribed.sent).toHaveLength(1);
    const opened = parseBinaryFrame(subscribed.sent[0]!)!;
    const openedDecoder = decoding.createDecoder(opened.payload);
    expect(decoding.readVarUint(openedDecoder)).toBe(syncProtocol.messageYjsSyncStep1);

    // A different socket sends a real Yjs update for this doc, accepted via handleBinaryFrame.
    const clientDoc = new Y.Doc();
    clientDoc.gc = false;
    let capturedUpdate: Uint8Array | null = null;
    clientDoc.on("update", (u: Uint8Array) => (capturedUpdate = u));
    clientDoc.getText("body").insert(0, "hello");
    const actingSocket = new FakeSocket();
    await registry.handleOpen(actingSocket as unknown as never, docId);
    await registry.handleBinaryFrame(
      actingSocket as unknown as never,
      docId,
      Buffer.from(encodeClientUpdate(capturedUpdate!)),
    );

    // fanOutDocUpdate needs the real doc_updates.id — fetch it from the durable row directly.
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM doc_updates WHERE doc_id = $1 ORDER BY id DESC LIMIT 1`,
      [docId],
    );
    await registry.fanOutDocUpdate(docId, rows[0]!.id);

    const subscribedFrame = lastFramePayload(subscribed, docId);
    const subscribedDecoder = decoding.createDecoder(subscribedFrame);
    expect(decoding.readVarUint(subscribedDecoder)).toBe(syncProtocol.messageYjsUpdate);

    expect(unsubscribed.sent).toHaveLength(1); // only its initial SyncStep1 — never the fan-out
  });

  it("converges two subscribed clients after concurrent, duplicate, and out-of-order updates", async () => {
    const socketA = new FakeSocket();
    const socketB = new FakeSocket();
    await registry.handleOpen(socketA as unknown as never, docId);
    await registry.handleOpen(socketB as unknown as never, docId);

    const clientA = new Y.Doc();
    clientA.gc = false;
    const updatesFromA: Uint8Array[] = [];
    clientA.on("update", (u: Uint8Array) => updatesFromA.push(u));
    clientA.getText("body").insert(0, "AAA");

    const clientB = new Y.Doc();
    clientB.gc = false;
    const updatesFromB: Uint8Array[] = [];
    clientB.on("update", (u: Uint8Array) => updatesFromB.push(u));
    clientB.getText("body").insert(0, "BBB");

    // Concurrent, then a duplicate resend of A's own update, then B's update arriving after A's.
    await registry.handleBinaryFrame(
      socketA as unknown as never,
      docId,
      Buffer.from(encodeClientUpdate(updatesFromA[0]!)),
    );
    await registry.handleBinaryFrame(
      socketA as unknown as never,
      docId,
      Buffer.from(encodeClientUpdate(updatesFromA[0]!)),
    );
    await registry.handleBinaryFrame(
      socketB as unknown as never,
      docId,
      Buffer.from(encodeClientUpdate(updatesFromB[0]!)),
    );

    const merged = await loadYDoc(pool, docId);
    const mergedText = merged.getText("body").toJSON();
    expect(mergedText).toContain("AAA");
    expect(mergedText).toContain("BBB");

    // Both clients converge to the same state once they apply the same set of updates,
    // regardless of the order those updates were generated or resent in.
    const replay = new Y.Doc();
    replay.gc = false;
    Y.applyUpdate(replay, updatesFromB[0]!);
    Y.applyUpdate(replay, updatesFromA[0]!);
    Y.applyUpdate(replay, updatesFromA[0]!); // duplicate re-application is a no-op
    expect(replay.getText("body").toJSON()).toBe(mergedText);
  });

  it("recovers via a full resync when the referenced doc_updates row has already been compacted away", async () => {
    const socket = new FakeSocket();
    await registry.handleOpen(socket as unknown as never, docId);

    const clientDoc = new Y.Doc();
    clientDoc.gc = false;
    let capturedUpdate: Uint8Array | null = null;
    clientDoc.on("update", (u: Uint8Array) => (capturedUpdate = u));
    clientDoc.getText("body").insert(0, "compacted content");
    await registry.handleBinaryFrame(
      socket as unknown as never,
      docId,
      Buffer.from(encodeClientUpdate(capturedUpdate!)),
    );

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM doc_updates WHERE doc_id = $1 ORDER BY id DESC LIMIT 1`,
      [docId],
    );
    const updateId = rows[0]!.id;
    // Simulate a concurrent compaction: the row is gone, but its content is retained in
    // doc_snapshots (loadYDoc/mutateYDoc always fold pending updates back into the snapshot
    // lazily; here we just delete the row directly to exercise the missing-row path).
    await pool.query(`DELETE FROM doc_updates WHERE id = $1`, [updateId]);

    await registry.fanOutDocUpdate(docId, updateId);

    const frame = lastFramePayload(socket, docId);
    const decoder = decoding.createDecoder(frame);
    // Falls back to a full SyncStep2 resync rather than dropping the fan-out silently.
    expect(decoding.readVarUint(decoder)).toBe(syncProtocol.messageYjsSyncStep2);
  });

  it("persists an accepted update under the authenticated 'user' origin, never a client-supplied value", async () => {
    const socket = new FakeSocket();
    await registry.handleOpen(socket as unknown as never, docId);

    const clientDoc = new Y.Doc();
    clientDoc.gc = false;
    let capturedUpdate: Uint8Array | null = null;
    clientDoc.on("update", (u: Uint8Array) => (capturedUpdate = u));
    clientDoc.getText("body").insert(0, "attributed content");
    await registry.handleBinaryFrame(
      socket as unknown as never,
      docId,
      Buffer.from(encodeClientUpdate(capturedUpdate!)),
    );

    const { rows } = await pool.query<{ created_by: string }>(
      `SELECT created_by FROM doc_updates WHERE doc_id = $1 ORDER BY id DESC LIMIT 1`,
      [docId],
    );
    expect(rows[0]!.created_by).toBe("user");
  });

  it("replies to a client's SyncStep1 with a SyncStep2 diff of the server's current content", async () => {
    const socket = new FakeSocket();
    await registry.handleOpen(socket as unknown as never, docId);

    const clientDoc = new Y.Doc();
    clientDoc.gc = false;
    await registry.handleBinaryFrame(socket as unknown as never, docId, Buffer.from(encodeClientSyncStep1(clientDoc)));

    const frame = lastFramePayload(socket, docId);
    applyServerPayload(clientDoc, frame);
    const decoder = decoding.createDecoder(frame);
    expect(decoding.readVarUint(decoder)).toBe(syncProtocol.messageYjsSyncStep2);
    const update = decoding.readVarUint8Array(decoder);
    Y.applyUpdate(clientDoc, update);

    const serverDoc = await loadYDoc(pool, docId);
    expect(clientDoc.getText("body")?.toJSON() ?? "").toBe(serverDoc.getText("body").toJSON());
  });

  it("ignores a binary frame for a doc the socket never opened", async () => {
    const before = await pool.query(`SELECT count(*) FROM doc_updates WHERE doc_id = $1`, [docId]);

    const socket = new FakeSocket();
    const clientDoc = new Y.Doc();
    clientDoc.gc = false;
    let capturedUpdate: Uint8Array | null = null;
    clientDoc.on("update", (u: Uint8Array) => (capturedUpdate = u));
    clientDoc.getText("body").insert(0, "unsolicited");

    await registry.handleBinaryFrame(
      socket as unknown as never,
      docId,
      Buffer.from(encodeClientUpdate(capturedUpdate!)),
    );

    const after = await pool.query(`SELECT count(*) FROM doc_updates WHERE doc_id = $1`, [docId]);
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  it("stops fanning out to a socket once it has closed the document", async () => {
    const socketA = new FakeSocket();
    const socketB = new FakeSocket();
    await registry.handleOpen(socketA as unknown as never, docId);
    await registry.handleOpen(socketB as unknown as never, docId);
    registry.handleSocketClosed(socketB as unknown as never);

    const clientDoc = new Y.Doc();
    clientDoc.gc = false;
    let capturedUpdate: Uint8Array | null = null;
    clientDoc.on("update", (u: Uint8Array) => (capturedUpdate = u));
    clientDoc.getText("body").insert(0, "after close");
    await registry.handleBinaryFrame(
      socketA as unknown as never,
      docId,
      Buffer.from(encodeClientUpdate(capturedUpdate!)),
    );

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM doc_updates WHERE doc_id = $1 ORDER BY id DESC LIMIT 1`,
      [docId],
    );
    await registry.fanOutDocUpdate(docId, rows[0]!.id);

    expect(socketB.sent).toHaveLength(1); // only the original SyncStep1 from handleOpen
  });
});
