import { createServer, type Server } from "node:http";
import { afterAll, beforeEach, describe, expect, it, afterEach } from "vitest";
import { Pool } from "pg";
import { WebSocket, WebSocketServer } from "ws";
import { setDocUpdateHook, setInvalidationHook, notifyDocUpdate } from "@semprec/data";
import { publishRealtimeMessage } from "../pgNotifyPublisher.js";
import { wireRealtimeHooks } from "../wireHooks.js";
import { startRealtimeServer, type RealtimeServer } from "../wsServer.js";

let pool: Pool;

describe("realtime", () => {
  beforeEach(() => {
    // The shared embedded-Postgres instance (vitest globalSetup, packages/data) already
    // has migrations applied; these tests only exercise LISTEN/NOTIFY, not any of the
    // data package's own tables, so a plain Pool is enough — no need to reach into
    // @semprec/data's internal testSupport helpers for a table-truncating reset.
    pool ??= new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("wireRealtimeHooks turns a doc-update event into a Postgres NOTIFY on the shared channel", async () => {
    wireRealtimeHooks(pool);

    const listenClient = await pool.connect();
    await listenClient.query("LISTEN semprec_realtime");
    const received = new Promise<{ channel: string; payload?: string }>((resolve) => {
      listenClient.once("notification", resolve);
    });

    notifyDocUpdate({ docId: "doc-1", update: "AAA=", createdBy: "ai_agent" });

    const notification = await received;
    expect(JSON.parse(notification.payload ?? "{}")).toMatchObject({ type: "doc_update", docId: "doc-1", createdBy: "ai_agent" });

    listenClient.release(true);
    setInvalidationHook(() => {});
    setDocUpdateHook(() => {});
  });

  describe("startRealtimeServer", () => {
    let httpServer: Server;
    let wss: WebSocketServer;
    let realtimeServer: RealtimeServer;
    let port: number;

    beforeEach(async () => {
      httpServer = createServer();
      wss = new WebSocketServer({ server: httpServer });
      await new Promise<void>((resolve) => httpServer.listen(0, resolve));
      const address = httpServer.address();
      if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
      port = address.port;
      realtimeServer = await startRealtimeServer(pool, wss);
    });

    afterEach(async () => {
      await realtimeServer.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    it("broadcasts a NOTIFY on the realtime channel to every connected WS client", async () => {
      const client = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve, reject) => {
        client.once("open", () => resolve());
        client.once("error", reject);
      });

      const received = new Promise<string>((resolve) => {
        client.once("message", (data) => resolve(data.toString()));
      });

      await publishRealtimeMessage(pool, { type: "item_invalidation", databaseId: "db-1", itemId: "item-1", key: "status" });

      const message = await received;
      expect(JSON.parse(message)).toEqual({ type: "item_invalidation", databaseId: "db-1", itemId: "item-1", key: "status" });

      client.close();
    });
  });
});
