import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync.js";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  createChokePoint,
  createDocStore,
  loadYDoc,
  withTransaction,
  type ChokePoint,
  type DocStore,
} from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import { runInTenant } from "@semprec/shared";
import { createDocSyncRegistry, type DocSyncRegistry } from "../docSync.js";
import { appendClientUpdateId, decodeDocId, parseBinaryFrame } from "../protocolV1.js";

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
    await registry.handleOpen(socket as unknown as never, getTenantZeroId(), "00000000-0000-0000-0000-000000000000");
    expect(socket.sent).toHaveLength(0);
  });

  it("sends the server's SyncStep1 on open, and fans an accepted update out only to sockets with the doc open", async () => {
    const subscribed = new FakeSocket();
    const unsubscribed = new FakeSocket();
    await registry.handleOpen(subscribed as unknown as never, getTenantZeroId(), docId);
    await registry.handleOpen(unsubscribed as unknown as never, getTenantZeroId(), docId);
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
    await registry.handleOpen(actingSocket as unknown as never, getTenantZeroId(), docId);
    await registry.handleBinaryFrame(
      actingSocket as unknown as never,
      getTenantZeroId(),
      docId,
      Buffer.from(encodeClientUpdate(capturedUpdate!)),
    );

    // fanOutDocUpdate needs the real doc_updates.id — fetch it from the durable row directly.
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM doc_updates WHERE doc_id = $1 ORDER BY id DESC LIMIT 1`,
      [docId],
    );
    await registry.fanOutDocUpdate(getTenantZeroId(), docId, rows[0]!.id);

    const subscribedFrame = lastFramePayload(subscribed, docId);
    const subscribedDecoder = decoding.createDecoder(subscribedFrame);
    expect(decoding.readVarUint(subscribedDecoder)).toBe(syncProtocol.messageYjsUpdate);

    expect(unsubscribed.sent).toHaveLength(1); // only its initial SyncStep1 — never the fan-out
  });

  it("converges two subscribed clients after concurrent, duplicate, and out-of-order updates", async () => {
    const socketA = new FakeSocket();
    const socketB = new FakeSocket();
    await registry.handleOpen(socketA as unknown as never, getTenantZeroId(), docId);
    await registry.handleOpen(socketB as unknown as never, getTenantZeroId(), docId);

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
      getTenantZeroId(),
      docId,
      Buffer.from(encodeClientUpdate(updatesFromA[0]!)),
    );
    await registry.handleBinaryFrame(
      socketA as unknown as never,
      getTenantZeroId(),
      docId,
      Buffer.from(encodeClientUpdate(updatesFromA[0]!)),
    );
    await registry.handleBinaryFrame(
      socketB as unknown as never,
      getTenantZeroId(),
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
    await registry.handleOpen(socket as unknown as never, getTenantZeroId(), docId);

    const clientDoc = new Y.Doc();
    clientDoc.gc = false;
    let capturedUpdate: Uint8Array | null = null;
    clientDoc.on("update", (u: Uint8Array) => (capturedUpdate = u));
    clientDoc.getText("body").insert(0, "compacted content");
    await registry.handleBinaryFrame(
      socket as unknown as never,
      getTenantZeroId(),
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

    await registry.fanOutDocUpdate(getTenantZeroId(), docId, updateId);

    const frame = lastFramePayload(socket, docId);
    const decoder = decoding.createDecoder(frame);
    // Falls back to a full SyncStep2 resync rather than dropping the fan-out silently.
    expect(decoding.readVarUint(decoder)).toBe(syncProtocol.messageYjsSyncStep2);
  });

  it("persists an accepted update under the authenticated 'user' origin, never a client-supplied value", async () => {
    const socket = new FakeSocket();
    await registry.handleOpen(socket as unknown as never, getTenantZeroId(), docId);

    const clientDoc = new Y.Doc();
    clientDoc.gc = false;
    let capturedUpdate: Uint8Array | null = null;
    clientDoc.on("update", (u: Uint8Array) => (capturedUpdate = u));
    clientDoc.getText("body").insert(0, "attributed content");
    await registry.handleBinaryFrame(
      socket as unknown as never,
      getTenantZeroId(),
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
    await registry.handleOpen(socket as unknown as never, getTenantZeroId(), docId);

    const clientDoc = new Y.Doc();
    clientDoc.gc = false;
    await registry.handleBinaryFrame(
      socket as unknown as never,
      getTenantZeroId(),
      docId,
      Buffer.from(encodeClientSyncStep1(clientDoc)),
    );

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
      getTenantZeroId(),
      docId,
      Buffer.from(encodeClientUpdate(capturedUpdate!)),
    );

    const after = await pool.query(`SELECT count(*) FROM doc_updates WHERE doc_id = $1`, [docId]);
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  it("stops fanning out to a socket once it has closed the document", async () => {
    const socketA = new FakeSocket();
    const socketB = new FakeSocket();
    await registry.handleOpen(socketA as unknown as never, getTenantZeroId(), docId);
    await registry.handleOpen(socketB as unknown as never, getTenantZeroId(), docId);
    registry.handleSocketClosed(socketB as unknown as never);

    const clientDoc = new Y.Doc();
    clientDoc.gc = false;
    let capturedUpdate: Uint8Array | null = null;
    clientDoc.on("update", (u: Uint8Array) => (capturedUpdate = u));
    clientDoc.getText("body").insert(0, "after close");
    await registry.handleBinaryFrame(
      socketA as unknown as never,
      getTenantZeroId(),
      docId,
      Buffer.from(encodeClientUpdate(capturedUpdate!)),
    );

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM doc_updates WHERE doc_id = $1 ORDER BY id DESC LIMIT 1`,
      [docId],
    );
    await registry.fanOutDocUpdate(getTenantZeroId(), docId, rows[0]!.id);

    expect(socketB.sent).toHaveLength(1); // only the original SyncStep1 from handleOpen
  });
});

describe("createDocSyncRegistry tenant isolation (issue #1026)", () => {
  let runtimePool: Pool;
  let registry: DocSyncRegistry;
  let tenantA: string;
  let tenantB: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    tenantA = getTenantZeroId();
    tenantB = await createTestTenant(pool);
    // Row-level security applies only to a runtime role, so the registry under test reads through one.
    runtimePool = await createRuntimeRolePool(pool, "semprec_data");
    registry = createDocSyncRegistry(runtimePool);
  });

  afterEach(async () => {
    await runtimePool.end();
  });

  async function createDocIn(tenantId: string): Promise<string> {
    return runInTenant(tenantId, async () => {
      const db = await createChokePoint(runtimePool).createDatabase({ name: "Pages" });
      const item = await createChokePoint(runtimePool).createItem({ databaseId: db.id, properties: {} });
      const store = createDocStore(runtimePool);
      await store.putBlock(item.id, { id: "root", flavour: "page" }, "user");
      const doc = await store.getDoc(item.id);
      return doc!.id;
    });
  }

  function textUpdateFrame(text: string): Buffer {
    const clientDoc = new Y.Doc();
    clientDoc.gc = false;
    let captured: Uint8Array | null = null;
    clientDoc.on("update", (u: Uint8Array) => (captured = u));
    clientDoc.getText("body").insert(0, text);
    return Buffer.from(encodeClientUpdate(captured!));
  }

  async function latestUpdateId(docId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM doc_updates WHERE doc_id = $1 ORDER BY id DESC LIMIT 1`,
      [docId],
    );
    return rows[0]!.id;
  }

  async function countUpdates(): Promise<string> {
    const { rows } = await pool.query<{ count: string }>(`SELECT count(*) FROM doc_updates`);
    return rows[0]!.count;
  }

  function syncStep1Frame(): Buffer {
    return Buffer.from(encodeClientSyncStep1(new Y.Doc()));
  }

  it("treats another tenant's doc exactly like an unknown id: no frame, no write", async () => {
    const docA = await createDocIn(tenantA);
    const foreign = new FakeSocket();
    const unknown = new FakeSocket();

    await registry.handleOpen(foreign as unknown as never, tenantB, docA);
    await registry.handleOpen(unknown as unknown as never, tenantB, "00000000-0000-0000-0000-000000000000");
    expect(foreign.sent).toHaveLength(0);
    expect(unknown.sent).toHaveLength(0);

    const before = await countUpdates();
    await registry.handleBinaryFrame(foreign as unknown as never, tenantB, docA, textUpdateFrame("intrusion"));
    await registry.handleBinaryFrame(foreign as unknown as never, tenantB, docA, syncStep1Frame());
    expect(await countUpdates()).toBe(before);
    expect(foreign.sent).toHaveLength(0);
  });

  it("drops binary frames sent for another tenant's doc while its doc:open lookup is still pending", async () => {
    const docA = await createDocIn(tenantA);
    const foreign = new FakeSocket();
    const before = await countUpdates();

    // Not awaited: the open's reservation is taken synchronously, its tenant-scoped lookup is in flight.
    const opening = registry.handleOpen(foreign as unknown as never, tenantB, docA);
    const frames = Promise.all([
      registry.handleBinaryFrame(foreign as unknown as never, tenantB, docA, textUpdateFrame("intrusion")),
      registry.handleBinaryFrame(foreign as unknown as never, tenantB, docA, syncStep1Frame()),
    ]);
    await Promise.all([opening, frames]);

    expect(await countUpdates()).toBe(before);
    expect(foreign.sent).toHaveLength(0);
  });

  it("releases a foreign doc's reservation: the socket can still fill all 32 slots with its own docs", async () => {
    const docA = await createDocIn(tenantA);
    const socket = new FakeSocket();
    await registry.handleOpen(socket as unknown as never, tenantB, docA);

    const ownDocs: string[] = [];
    for (let i = 0; i < 33; i++) ownDocs.push(await createDocIn(tenantB));
    for (const own of ownDocs.slice(0, 32)) {
      await registry.handleOpen(socket as unknown as never, tenantB, own);
    }
    // A leaked reservation would have left only 31 slots, so the 32nd own doc would get no SyncStep1.
    expect(socket.sent).toHaveLength(32);

    // The cap itself still holds: a 33rd document is refused.
    await registry.handleOpen(socket as unknown as never, tenantB, ownDocs[32]!);
    expect(socket.sent).toHaveLength(32);
  });

  it("persists a same-tenant update with the socket's tenant_id and delivers it to another subscriber", async () => {
    const docA = await createDocIn(tenantA);
    const writer = new FakeSocket();
    const peer = new FakeSocket();
    await registry.handleOpen(writer as unknown as never, tenantA, docA);
    await registry.handleOpen(peer as unknown as never, tenantA, docA);
    expect(decoding.readVarUint(decoding.createDecoder(lastFramePayload(writer, docA)))).toBe(
      syncProtocol.messageYjsSyncStep1,
    );

    await registry.handleBinaryFrame(writer as unknown as never, tenantA, docA, textUpdateFrame("own tenant"));
    const { rows } = await pool.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM doc_updates WHERE doc_id = $1 ORDER BY id DESC LIMIT 1`,
      [docA],
    );
    expect(rows[0]!.tenant_id).toBe(tenantA);

    await registry.fanOutDocUpdate(tenantA, docA, await latestUpdateId(docA));
    const decoder = decoding.createDecoder(lastFramePayload(peer, docA));
    expect(decoding.readVarUint(decoder)).toBe(syncProtocol.messageYjsUpdate);
  });

  it("never fans a reference stamped with another tenant out to a subscriber of that doc", async () => {
    const docA = await createDocIn(tenantA);
    const writer = new FakeSocket();
    const subscriber = new FakeSocket();
    await registry.handleOpen(writer as unknown as never, tenantA, docA);
    await registry.handleOpen(subscriber as unknown as never, tenantA, docA);
    await registry.handleBinaryFrame(writer as unknown as never, tenantA, docA, textUpdateFrame("secret"));
    const updateA = await latestUpdateId(docA);

    await registry.fanOutDocUpdate(tenantB, docA, updateA);
    expect(subscriber.sent).toHaveLength(1); // only its SyncStep1

    await registry.fanOutDocUpdate(tenantA, docA, updateA);
    expect(subscriber.sent).toHaveLength(2);
  });

  it("gives subscribers a full resync, never another doc's bytes, for a reference whose update belongs to a different doc", async () => {
    const docA1 = await createDocIn(tenantA);
    const docA2 = await createDocIn(tenantA);
    const writer = new FakeSocket();
    const subscriber = new FakeSocket();
    await registry.handleOpen(writer as unknown as never, tenantA, docA2);
    await registry.handleOpen(subscriber as unknown as never, tenantA, docA1);
    await registry.handleBinaryFrame(writer as unknown as never, tenantA, docA2, textUpdateFrame("doc two only"));
    const updateOfA2 = await latestUpdateId(docA2);

    await registry.fanOutDocUpdate(tenantA, docA1, updateOfA2);

    const decoder = decoding.createDecoder(lastFramePayload(subscriber, docA1));
    expect(decoding.readVarUint(decoder)).toBe(syncProtocol.messageYjsSyncStep2);
    const received = new Y.Doc();
    Y.applyUpdate(received, decoding.readVarUint8Array(decoder));
    expect(received.getText("body").toJSON()).toBe("");
  });
});

describe("createDocSyncRegistry doc:ack (issue #1362)", () => {
  let runtimePool: Pool;
  let registry: DocSyncRegistry;
  let tenantA: string;
  let tenantB: string;
  let docId: string;

  /** Starts persistence reads when each ack is sent. */
  class AckSocket extends FakeSocket {
    readonly rowsAtAck: Promise<number>[] = [];
    readonly textAtAck: Promise<string>[] = [];
    override send(data: Buffer | string): void {
      super.send(data as Buffer);
      if (typeof data === "string" && JSON.parse(data).type === "doc:ack") {
        this.rowsAtAck.push(
          pool
            .query<{ count: string }>(`SELECT count(*) FROM doc_updates WHERE doc_id = $1`, [docId])
            .then((r) => Number(r.rows[0]!.count)),
        );
        this.textAtAck.push(
          runInTenant(tenantA, () => loadYDoc(runtimePool, docId)).then((doc) => doc.getText("body").toJSON()),
        );
      }
    }
  }

  function acks(socket: FakeSocket): unknown[] {
    return (socket.sent as (Buffer | string)[])
      .filter((d): d is string => typeof d === "string")
      .map((d) => JSON.parse(d) as { type: string })
      .filter((f) => f.type === "doc:ack");
  }

  function updateBytes(text: string): Uint8Array {
    const clientDoc = new Y.Doc();
    clientDoc.gc = false;
    let captured: Uint8Array | null = null;
    clientDoc.on("update", (u: Uint8Array) => (captured = u));
    clientDoc.getText("body").insert(0, text);
    return captured!;
  }

  /** An Update message, optionally with a trailing client update id. */
  function frame(update: Uint8Array, clientUpdateId?: string): Buffer {
    const message = encodeClientUpdate(update);
    return Buffer.from(clientUpdateId === undefined ? message : appendClientUpdateId(message, clientUpdateId));
  }

  async function countUpdates(): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(`SELECT count(*) FROM doc_updates`);
    return Number(rows[0]!.count);
  }

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    tenantA = getTenantZeroId();
    tenantB = await createTestTenant(pool);
    runtimePool = await createRuntimeRolePool(pool, "semprec_data");
    registry = createDocSyncRegistry(runtimePool);
    docId = await runInTenant(tenantA, async () => {
      const db = await createChokePoint(runtimePool).createDatabase({ name: "Pages" });
      const item = await createChokePoint(runtimePool).createItem({ databaseId: db.id, properties: {} });
      const store = createDocStore(runtimePool);
      await store.putBlock(item.id, { id: "root", flavour: "page" }, "user");
      return (await store.getDoc(item.id))!.id;
    });
  });

  afterEach(async () => {
    await runtimePool.end();
  });

  it("acknowledges to the sender only, after the update is stored, and fans the update out to the others", async () => {
    const writer = new AckSocket();
    const peer = new AckSocket();
    await registry.handleOpen(writer as unknown as never, tenantA, docId);
    await registry.handleOpen(peer as unknown as never, tenantA, docId);
    const before = await countUpdates();

    await registry.handleBinaryFrame(writer as unknown as never, tenantA, docId, frame(updateBytes("hi"), "edit-1"));

    const observations = await Promise.allSettled([...writer.rowsAtAck, ...writer.textAtAck]);
    expect(acks(writer)).toEqual([{ type: "doc:ack", docId, clientUpdateId: "edit-1" }]);
    expect(observations).toEqual([
      { status: "fulfilled", value: before + 1 },
      { status: "fulfilled", value: "hi" },
    ]);
    expect(acks(peer)).toEqual([]);

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM doc_updates WHERE doc_id = $1 ORDER BY id DESC LIMIT 1`,
      [docId],
    );
    await registry.fanOutDocUpdate(tenantA, docId, rows[0]!.id);
    const decoder = decoding.createDecoder(lastFramePayload(peer, docId));
    expect(decoding.readVarUint(decoder)).toBe(syncProtocol.messageYjsUpdate);
    expect(acks(peer)).toEqual([]);
  });

  it("does not acknowledge before the update transaction commits", async () => {
    const socket = new FakeSocket();
    const peer = new FakeSocket();
    await registry.handleOpen(socket as unknown as never, tenantA, docId);
    await registry.handleOpen(peer as unknown as never, tenantA, docId);
    let blocker: PoolClient | undefined;
    let locked = false;
    let discardBlocker = false;
    let triggerCreated = false;
    let operation: Promise<PromiseSettledResult<void>> | undefined;
    let failure: { error: unknown } | undefined;
    const cleanupErrors: unknown[] = [];
    try {
      // A deferred trigger blocks the actual COMMIT after the valid update has been inserted.
      await withTransaction(pool, async (client) => {
        await client.query(`CREATE FUNCTION batch16_hold_doc_commit() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN PERFORM set_config('lock_timeout', '10s', true);
          PERFORM pg_advisory_xact_lock(hashtextextended(NEW.doc_id::text, 1602)); RETURN NEW; END $$`);
        await client.query(`CREATE CONSTRAINT TRIGGER batch16_hold_doc_commit AFTER INSERT ON doc_updates
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION batch16_hold_doc_commit()`);
      });
      triggerCreated = true;
      blocker = await pool.connect();
      const pid = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const blockerPid = pid.rows[0]?.pid;
      if (blockerPid === undefined) throw new Error("Missing gate connection PID");
      await blocker.query("SELECT pg_advisory_lock(hashtextextended($1::text, 1602))", [docId]);
      locked = true;
      operation = registry
        .handleBinaryFrame(socket as unknown as never, tenantA, docId, frame(updateBytes("gated"), "gate-id"))
        .then<PromiseSettledResult<void>, PromiseSettledResult<void>>(
          () => ({ status: "fulfilled", value: undefined }),
          (reason: unknown) => ({ status: "rejected", reason }),
        );
      await vi.waitFor(
        async () => {
          const waiting = await pool.query<{ waiting: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))) AS waiting",
            [blockerPid],
          );
          expect(waiting.rows[0]?.waiting).toBe(true);
        },
        { timeout: 5000, interval: 25 },
      );
      expect(acks(socket)).toEqual([]);
      expect(acks(peer)).toEqual([]);
    } catch (error) {
      failure = { error };
    }
    if (locked && blocker) {
      try {
        const unlocked = await blocker.query<{ unlocked: boolean }>(
          "SELECT pg_advisory_unlock(hashtextextended($1::text, 1602)) AS unlocked",
          [docId],
        );
        if (!unlocked.rows[0]?.unlocked) throw new Error("The gate lock was not held");
      } catch (error) {
        discardBlocker = true;
        cleanupErrors.push(error);
      }
    }
    const settled = operation ? await operation : undefined;
    if (settled?.status === "rejected") cleanupErrors.push(settled.reason);
    if (blocker) {
      try {
        blocker.release(discardBlocker);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (triggerCreated) {
      try {
        await withTransaction(pool, async (client) => {
          await client.query("DROP TRIGGER batch16_hold_doc_commit ON doc_updates");
          await client.query("DROP FUNCTION batch16_hold_doc_commit()");
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        failure ? [failure.error, ...cleanupErrors] : cleanupErrors,
        "Gate test cleanup failed",
        { cause: failure?.error },
      );
    if (failure) throw failure.error;
    expect(settled?.status).toBe("fulfilled");
    expect(acks(socket)).toEqual([{ type: "doc:ack", docId, clientUpdateId: "gate-id" }]);
    expect(acks(peer)).toEqual([]);
    const persisted = await runInTenant(tenantA, () => loadYDoc(runtimePool, docId));
    expect(persisted.getText("body").toJSON()).toBe("gated");
  }, 20_000);

  it("acknowledges a SyncStep2 message that carries an id", async () => {
    const socket = new FakeSocket();
    await registry.handleOpen(socket as unknown as never, tenantA, docId);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, syncProtocol.messageYjsSyncStep2);
    encoding.writeVarUint8Array(encoder, updateBytes("step2"));
    const payload = appendClientUpdateId(encoding.toUint8Array(encoder), "s2");

    await registry.handleBinaryFrame(socket as unknown as never, tenantA, docId, Buffer.from(payload));

    expect(acks(socket)).toEqual([{ type: "doc:ack", docId, clientUpdateId: "s2" }]);
  });

  it("acknowledges a replayed update again without storing a second row", async () => {
    const socket = new FakeSocket();
    await registry.handleOpen(socket as unknown as never, tenantA, docId);
    const update = updateBytes("once");

    await registry.handleBinaryFrame(socket as unknown as never, tenantA, docId, frame(update, "same-id"));
    const stored = await countUpdates();
    await registry.handleBinaryFrame(socket as unknown as never, tenantA, docId, frame(update, "same-id"));

    expect(await countUpdates()).toBe(stored);
    expect(acks(socket)).toEqual([
      { type: "doc:ack", docId, clientUpdateId: "same-id" },
      { type: "doc:ack", docId, clientUpdateId: "same-id" },
    ]);
  });

  it.each([
    ["no id", undefined],
    ["an over-long id", "a".repeat(65)],
    ["an id with other characters", "bad id!"],
    ["an empty id", ""],
  ])("persists an update with %s and sends no ack", async (_label, id) => {
    const socket = new FakeSocket();
    await registry.handleOpen(socket as unknown as never, tenantA, docId);
    const before = await countUpdates();

    await registry.handleBinaryFrame(socket as unknown as never, tenantA, docId, frame(updateBytes("x"), id));

    expect(await countUpdates()).toBe(before + 1);
    expect(acks(socket)).toEqual([]);
  });

  it("accepts a 64-character id", async () => {
    const socket = new FakeSocket();
    await registry.handleOpen(socket as unknown as never, tenantA, docId);
    const id = "a".repeat(64);
    await registry.handleBinaryFrame(socket as unknown as never, tenantA, docId, frame(updateBytes("x"), id));
    expect(acks(socket)).toEqual([{ type: "doc:ack", docId, clientUpdateId: id }]);
  });

  it("persists an update with a truncated correlation string and sends no ack", async () => {
    const socket = new FakeSocket();
    await registry.handleOpen(socket as unknown as never, tenantA, docId);
    const before = await countUpdates();
    // Synthetic malformed boundary: the declared varString length exceeds its remaining bytes.
    const malformed = Buffer.concat([Buffer.from(encodeClientUpdate(updateBytes("truncated"))), Buffer.from([3, 97])]);

    await registry.handleBinaryFrame(socket as unknown as never, tenantA, docId, malformed);

    expect(await countUpdates()).toBe(before + 1);
    expect(acks(socket)).toEqual([]);
  });

  it("sends no ack and writes nothing for a document the socket never opened", async () => {
    const socket = new FakeSocket();
    const before = await countUpdates();
    await registry.handleBinaryFrame(socket as unknown as never, tenantA, docId, frame(updateBytes("x"), "id-1"));
    expect(await countUpdates()).toBe(before);
    expect(socket.sent).toHaveLength(0);
  });

  it("sends no ack and writes nothing for another tenant's document", async () => {
    const foreign = new FakeSocket();
    await registry.handleOpen(foreign as unknown as never, tenantB, docId);
    const before = await countUpdates();
    await registry.handleBinaryFrame(foreign as unknown as never, tenantB, docId, frame(updateBytes("x"), "id-1"));
    expect(await countUpdates()).toBe(before);
    expect(foreign.sent).toHaveLength(0);
  });

  it("sends no ack for a frame over the per-socket rate limit", async () => {
    const socket = new FakeSocket();
    await registry.handleOpen(socket as unknown as never, tenantA, docId);
    for (let i = 0; i < 50; i++) {
      await registry.handleBinaryFrame(
        socket as unknown as never,
        tenantA,
        docId,
        frame(updateBytes(`u${i}`), `id-${i}`),
      );
    }
    expect(acks(socket)).toHaveLength(50);
    const before = await countUpdates();

    await registry.handleBinaryFrame(
      socket as unknown as never,
      tenantA,
      docId,
      frame(updateBytes("over"), "over-limit"),
    );

    expect(acks(socket)).toHaveLength(50);
    expect(await countUpdates()).toBe(before);
  });

  it("sends no ack when persisting fails", async () => {
    const socket = new FakeSocket();
    await registry.handleOpen(socket as unknown as never, tenantA, docId);
    const before = await countUpdates();

    // Bytes that are not a valid Yjs update make the apply inside the transaction throw.
    await expect(
      registry.handleBinaryFrame(
        socket as unknown as never,
        tenantA,
        docId,
        frame(new Uint8Array([255, 255, 255]), "bad"),
      ),
    ).rejects.toThrow();

    expect(acks(socket)).toEqual([]);
    expect(await countUpdates()).toBe(before);
  });

  it("sends no ack when a valid update fails at the persistence insert", async () => {
    const socket = new FakeSocket();
    await registry.handleOpen(socket as unknown as never, tenantA, docId);
    const before = await countUpdates();
    // Inject a database failure at the actual update-row insertion boundary.
    await withTransaction(pool, async (client) => {
      await client.query(
        "CREATE FUNCTION batch16_reject_doc_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected doc persistence failure'; END $$",
      );
      await client.query(
        "CREATE TRIGGER batch16_reject_doc_update BEFORE INSERT ON doc_updates FOR EACH ROW EXECUTE FUNCTION batch16_reject_doc_update()",
      );
    });
    let failure: { error: unknown } | undefined;
    try {
      await expect(
        registry.handleBinaryFrame(socket as unknown as never, tenantA, docId, frame(updateBytes("valid"), "failed")),
      ).rejects.toThrow("injected doc persistence failure");
      expect(acks(socket)).toEqual([]);
      expect(await countUpdates()).toBe(before);
    } catch (error) {
      failure = { error };
    }
    try {
      await withTransaction(pool, async (client) => {
        await client.query("DROP TRIGGER batch16_reject_doc_update ON doc_updates");
        await client.query("DROP FUNCTION batch16_reject_doc_update()");
      });
    } catch (error) {
      if (failure) throw new AggregateError([failure.error, error], "Test and cleanup failed", { cause: error });
      throw error;
    }
    if (failure) throw failure.error;
  });
});
