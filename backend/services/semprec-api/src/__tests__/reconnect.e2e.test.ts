import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { WebSocket } from "ws";
import * as Y from "yjs";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createAgentRun,
  createChokePoint,
  createDocStore,
  createUser,
  createViewTypeRegistry,
  hashPassword,
  insertAgentRunEvent,
  loadFullModuleRegistry,
  loadYDoc,
  LocalFsBlobStorageWriter,
  login,
  seedSystem,
  withTransaction,
  writeNotification,
  type ChokePoint,
  type DocStore,
  type PasswordResetMailer,
} from "@semprec/data";
import type { SyncServer } from "@semprec/realtime";
import { createSyncClient, type SyncClient, type WebSocketLike } from "@semprec/realtime-client";
import { createDispatcher } from "../app.js";
import { createSyncUpgradeHandler } from "../syncHandler.js";

const PASSWORD = "s3cret-password";
const tmpBlobDir = join(tmpdir(), `semprec-realtime-client-e2e-${randomUUID()}`);

const noopMailer: PasswordResetMailer = {
  async sendPasswordResetEmail() {},
};

let pool: Pool;
let chokePoint: ChokePoint;
let docStore: DocStore;
const moduleRegistry = await loadFullModuleRegistry();

/** Polls a synchronous predicate — this test exercises a real (unmocked) backoff timer and real
 * sockets, so it waits on wall-clock time rather than fake timers. */
async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Polls an async predicate, e.g. one that re-reads durable Yjs state on every attempt. */
async function waitUntilAsync(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`waitUntilAsync: condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Intercepts `createSyncServer`'s dedicated LISTEN connection, the same way `syncServer.test.ts`
 * does for issue #242's own fault-injection tests, so this client-side suite can force the same
 * LISTEN-connection-loss fault without any test-only hook in production code.
 */
async function captureListenClient(create: () => Promise<SyncServer>): Promise<{ syncServer: SyncServer; listenClient: PoolClient }> {
  const originalConnect = pool.connect.bind(pool);
  let resolveClient: (client: PoolClient) => void;
  const clientPromise = new Promise<PoolClient>((resolve) => {
    resolveClient = resolve;
  });
  const poolConnect = pool as unknown as { connect: () => Promise<PoolClient> };
  const spy = vi.spyOn(poolConnect, "connect").mockImplementationOnce(async () => {
    const client = await originalConnect();
    resolveClient(client);
    return client;
  });
  let syncServer: SyncServer;
  try {
    syncServer = await create();
  } finally {
    spy.mockRestore();
  }
  return { syncServer, listenClient: await clientPromise };
}

class Harness {
  server!: Server;
  syncServer!: SyncServer;
  baseUrl!: string;
  wsBaseUrl!: string;

  async rebindUpgrade(syncServer: SyncServer): Promise<void> {
    this.syncServer = syncServer;
    this.server.removeAllListeners("upgrade");
    this.server.on("upgrade", (req, socket, head) => syncServer.handleUpgrade(req, socket, head));
  }
}

async function startServer(createSync: () => Promise<SyncServer> = () => createSyncUpgradeHandler(pool)): Promise<Harness> {
  const dispatch = await createDispatcher(pool, {
    passwordResetMailer: noopMailer,
    appBaseUrl: "http://localhost",
    setupToken: "unused-setup-token",
    moduleRegistry,
    blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
    maxFileSizeBytes: 10 * 1024 * 1024,
  });
  const syncServer = await createSync();
  const harness = new Harness();
  harness.server = createServer(dispatch);
  await harness.rebindUpgrade(syncServer);
  await new Promise<void>((resolve) => harness.server.listen(0, resolve));
  const address = harness.server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  harness.baseUrl = `http://127.0.0.1:${address.port}`;
  harness.wsBaseUrl = `ws://127.0.0.1:${address.port}`;
  return harness;
}

async function stopServer(harness: Harness): Promise<void> {
  await harness.syncServer.close().catch(() => {});
  await new Promise<void>((resolve) => harness.server.close(() => resolve()));
}

interface Fixture {
  userId: string;
  token: string;
  databaseId: string;
  viewId: string;
  itemId: string;
  docId: string;
  agentRunId: string;
  firstEventId: string;
}

async function buildFixture(): Promise<Fixture> {
  const user = await createUser(pool, { email: `${randomUUID()}@example.com`, passwordHash: await hashPassword(PASSWORD) });
  const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });

  const database = await chokePoint.createDatabase({ name: "D" });
  await chokePoint.createProperty({ databaseId: database.id, key: "title", name: "Title", type: "text" });
  const view = await chokePoint.createView({ databaseId: database.id, type: "table", name: "All rows" });
  const item = await chokePoint.createItem({ databaseId: database.id, properties: { title: "original" } });

  await docStore.putBlock(item.id, { id: "root", flavour: "page" }, "user");
  const doc = await docStore.getDoc(item.id);
  if (!doc) throw new Error("expected a docs row after putBlock");

  const run = await createAgentRun(pool, { triggeredBy: "user", task: "e2e reconnect" });
  const firstEvent = await insertAgentRunEvent(pool, run.id, "turn_start", { kind: "turn_start" });

  return {
    userId: user.id,
    token,
    databaseId: database.id,
    viewId: view.id,
    itemId: item.id,
    docId: doc.id,
    agentRunId: run.id,
    firstEventId: firstEvent.id,
  };
}

interface ItemBody {
  id: string;
  properties: Record<string, unknown>;
}

interface ViewQueryBody {
  items: { id: string }[];
}

interface UnreadBody {
  notifications: { id: string; readAt: string | null }[];
}

/** Everything a converged client should show, kept in sync purely by this rig's recovery hooks — never asserted on directly by a test until after a fault. */
interface ClientRig {
  client: SyncClient;
  sockets: WebSocket[];
  itemSnapshot: ItemBody | null;
  viewItemIds: string[];
  unreadIds: string[];
  agentEvents: string[];
  ydoc: Y.Doc;
}

function buildRig(harness: Harness, fixture: Fixture): ClientRig {
  const ydoc = new Y.Doc();
  ydoc.gc = false;
  const rig: ClientRig = {
    client: undefined as unknown as SyncClient,
    sockets: [],
    itemSnapshot: null,
    viewItemIds: [],
    unreadIds: [],
    agentEvents: [fixture.firstEventId],
    ydoc,
  };

  const authHeaders = { Authorization: `Bearer ${fixture.token}` };

  rig.client = createSyncClient({
    createSocket: () => {
      const socket = new WebSocket(`${harness.wsBaseUrl}/api/sync`, { headers: authHeaders });
      rig.sockets.push(socket);
      return socket as unknown as WebSocketLike;
    },
    random: () => 0,
    refetchActiveState: async () => {
      const [itemRes, queryRes] = await Promise.all([
        fetch(`${harness.baseUrl}/api/items/${fixture.itemId}`, { headers: authHeaders }),
        fetch(`${harness.baseUrl}/api/views/${fixture.viewId}/query`, {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ limit: 50 }),
        }),
      ]);
      rig.itemSnapshot = (await itemRes.json()) as ItemBody;
      const queryBody = (await queryRes.json()) as ViewQueryBody;
      rig.viewItemIds = queryBody.items.map((entry) => entry.id);
    },
    fetchUnreadNotifications: async () => {
      const res = await fetch(`${harness.baseUrl}/api/notifications/unread`, { headers: authHeaders });
      const body = (await res.json()) as UnreadBody;
      rig.unreadIds = body.notifications.map((n) => n.id);
    },
    onAgentEvent: (_runId, event) => {
      rig.agentEvents.push(event.id);
    },
  });

  return rig;
}

async function connectAndOpenStreams(rig: ClientRig, fixture: Fixture): Promise<void> {
  rig.client.connect();
  await waitUntil(() => rig.sockets.length === 1 && rig.sockets[0]!.readyState === WebSocket.OPEN);
  await waitUntil(() => rig.itemSnapshot !== null);

  rig.client.openDoc(fixture.docId, rig.ydoc);
  rig.client.watchAgentRun(fixture.agentRunId, fixture.firstEventId);
  // The doc's own root block was written before this client ever connected, so a converged
  // `SyncStep1`/`SyncStep2` exchange must leave this ydoc non-empty before any fault is injected.
  await waitUntil(() => rig.ydoc.share.size > 0);
}

/** Asserts every stream converges with server truth after a fault + reconnect: REST, Yjs, agent events, unread. */
async function assertConverged(rig: ClientRig, fixture: Fixture, updatedTitle: string, secondEventId: string, notificationId: string): Promise<void> {
  await waitUntil(() => rig.itemSnapshot?.properties.title === updatedTitle);
  expect(rig.viewItemIds).toContain(fixture.itemId);

  await waitUntil(() => rig.agentEvents.includes(secondEventId));
  expect(rig.agentEvents).toEqual([fixture.firstEventId, secondEventId]);

  await waitUntilAsync(async () => {
    const serverDoc = await loadYDoc(pool, fixture.docId);
    return Buffer.from(Y.encodeStateVector(rig.ydoc)).equals(Buffer.from(Y.encodeStateVector(serverDoc)));
  });

  await waitUntil(() => rig.unreadIds.includes(notificationId));
}

describe("client reconnect and per-stream recovery (issue #164)", () => {
  let harness: Harness;

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    docStore ??= createDocStore(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
  });

  afterEach(async () => {
    if (harness) await stopServer(harness);
  });

  afterAll(async () => {
    await pool?.end();
  });

  /** Mutates every stream's server-side truth while the client is mid-fault, returning what a converged client must end up showing. */
  async function mutateWhileDisconnected(fixture: Fixture): Promise<{ title: string; secondEventId: string; notificationId: string }> {
    const title = "updated during reconnect";
    const updated = await chokePoint.updateItem(
      { databaseId: fixture.databaseId, itemId: fixture.itemId, propertiesPatch: { title } },
      fixture.userId,
    );
    expect(updated.properties.title).toBe(title);

    const secondEvent = await insertAgentRunEvent(pool, fixture.agentRunId, "turn_end", { kind: "turn_end" });
    await docStore.putBlock(
      fixture.itemId,
      { id: "note", flavour: "paragraph", fields: { text: "added while offline" } },
      "user",
    );

    const notificationId = await withTransaction(pool, (client) =>
      writeNotification(client, {
        userId: fixture.userId,
        kind: "agent_run_error",
        linkHref: null,
        sourceTable: "agent_runs",
        sourceId: fixture.agentRunId,
        transitionInstance: randomUUID(),
      }),
    );

    return { title, secondEventId: secondEvent.id, notificationId };
  }

  /** Builds a fresh harness/fixture/rig, connects, triggers `fault`, then asserts every stream converges — closing the rig's client on every exit path so no test leaves a reconnect timer running into the next one. */
  async function runScenario(
    setupHarness: () => Promise<Harness>,
    fault: (harness: Harness, rig: ClientRig) => Promise<void> | void,
  ): Promise<void> {
    harness = await setupHarness();
    const fixture = await buildFixture();
    const rig = buildRig(harness, fixture);
    try {
      await connectAndOpenStreams(rig, fixture);

      const socketCountBeforeFault = rig.sockets.length;
      await fault(harness, rig);
      // Mutated while this client is still disconnected (the 1s injected backoff gives ample
      // room), so the reconnect's one refetch below is guaranteed to observe the final state —
      // exactly what "no universal cursor, refetch after reconnect" promises, not a race with it.
      const expectation = await mutateWhileDisconnected(fixture);
      await waitUntil(() => rig.sockets.length > socketCountBeforeFault && rig.sockets[rig.sockets.length - 1]!.readyState === WebSocket.OPEN);

      await assertConverged(rig, fixture, expectation.title, expectation.secondEventId, expectation.notificationId);
    } finally {
      rig.client.close();
    }
  }

  it("recovers REST, Yjs and agent-event state after a raw network drop", async () => {
    await runScenario(
      () => startServer(),
      (_harness, rig) => {
        // Abrupt drop, no close handshake — the client only learns about this from the TCP layer.
        rig.sockets[0]!.terminate();
      },
    );
  }, 20_000);

  it("recovers after the server's LISTEN connection is lost (issue #242's fault)", async () => {
    let listenClient: PoolClient | undefined;
    await runScenario(
      async () => {
        const captured = await captureListenClient(() => createSyncUpgradeHandler(pool));
        listenClient = captured.listenClient;
        return startServer(() => Promise.resolve(captured.syncServer));
      },
      () => {
        // Simulates the LISTEN connection being lost (network blip, Postgres restart) — the
        // server closes every socket with 1012 and starts its own capped-backoff reconnect loop.
        listenClient!.emit("error", new Error("simulated LISTEN connection loss"));
      },
    );
  }, 20_000);

  it("recovers after a controlled server shutdown (deploy)", async () => {
    await runScenario(
      () => startServer(),
      async (harness) => {
        // A rolling restart behind a fixed port: the old process's sync server shuts down (1012
        // to every socket) and a fresh one takes over the same HTTP server's upgrade handling.
        await harness.syncServer.close();
        await harness.rebindUpgrade(await createSyncUpgradeHandler(pool));
      },
    );
  }, 20_000);

  it("recovers after a slow-consumer backpressure close", async () => {
    await runScenario(
      () => startServer(),
      (_harness, rig) => {
        // Mirrors the 1013 close code `syncServer.ts` sends a socket whose outbound buffer stays
        // over threshold — from this client's perspective, indistinguishable from any other
        // server-initiated drop.
        rig.sockets[0]!.close(1013, "slow consumer");
      },
    );
  }, 20_000);
});
