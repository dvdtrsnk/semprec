import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeEach, describe, expect, it, afterEach } from "vitest";
import { Pool } from "pg";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  setDocUpdateHook,
  setInvalidationHook,
  setNotificationCreatedHook,
  setNotificationReadStateHook,
  notifyDocUpdate,
  notifyNotificationCreated,
} from "@semprec/data";
import { publishRealtimeMessage } from "../pgNotifyPublisher.js";
import { wireRealtimeHooks } from "../wireHooks.js";
import { startRealtimeServer, type RealtimeServer } from "../wsServer.js";

let pool: Pool;

/**
 * `ws` hands a message over as `Buffer | ArrayBuffer | Buffer[]`, and the array case is a
 * fragmented frame — its default `toString()` joins the fragments with commas instead of
 * concatenating them, which would corrupt the JSON these tests parse.
 */
function messageText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}

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
    expect(JSON.parse(notification.payload ?? "{}")).toMatchObject({
      type: "doc_update",
      docId: "doc-1",
      createdBy: "ai_agent",
    });

    listenClient.release(true);
    setInvalidationHook(() => {});
    setDocUpdateHook(() => {});
  });

  it("wireRealtimeHooks turns a notification-created event into a user-scoped Postgres NOTIFY (issue #152)", async () => {
    wireRealtimeHooks(pool);

    const listenClient = await pool.connect();
    await listenClient.query("LISTEN semprec_realtime");
    const received = new Promise<{ channel: string; payload?: string }>((resolve) => {
      listenClient.once("notification", resolve);
    });

    notifyNotificationCreated({
      userId: "user-1",
      notification: {
        id: "notif-1",
        kind: "heartbeat_error",
        title: "Heartbeat failed",
        linkHref: "?page=heartbeats",
        sourceTable: "project_heartbeats",
        sourceId: "hb-1",
        transitionInstance: "job-1",
        payload: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        readAt: null,
      },
    });

    const notification = await received;
    expect(JSON.parse(notification.payload ?? "{}")).toMatchObject({
      type: "notification_created",
      userId: "user-1",
      notification: { id: "notif-1", title: "Heartbeat failed" },
    });

    listenClient.release(true);
    setNotificationCreatedHook(() => {});
    setNotificationReadStateHook(() => {});
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
        client.once("message", (data) => resolve(messageText(data)));
      });

      await publishRealtimeMessage(pool, {
        type: "item_invalidation",
        databaseId: "db-1",
        itemId: "item-1",
        key: "status",
      });

      const message = await received;
      expect(JSON.parse(message)).toEqual({
        type: "item_invalidation",
        databaseId: "db-1",
        itemId: "item-1",
        key: "status",
      });

      client.close();
    });
  });

  describe("startRealtimeServer with resolveUserId (issue #152)", () => {
    let httpServer: Server;
    let wss: WebSocketServer;
    let realtimeServer: RealtimeServer;
    let port: number;

    /** Simulates session verification off a `?userId=` query param — a real caller would look up a session token instead. */
    function resolveUserId(req: IncomingMessage): Promise<string | null> {
      const url = new URL(req.url ?? "/", "http://localhost");
      return Promise.resolve(url.searchParams.get("userId"));
    }

    beforeEach(async () => {
      httpServer = createServer();
      wss = new WebSocketServer({ server: httpServer });
      await new Promise<void>((resolve) => httpServer.listen(0, resolve));
      const address = httpServer.address();
      if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
      port = address.port;
      realtimeServer = await startRealtimeServer(pool, wss, { resolveUserId });
    });

    afterEach(async () => {
      await realtimeServer.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    async function connect(userId: string | null): Promise<WebSocket> {
      const query = userId ? `?userId=${encodeURIComponent(userId)}` : "";
      const client = new WebSocket(`ws://127.0.0.1:${port}${query}`);
      await new Promise<void>((resolve, reject) => {
        client.once("open", () => resolve());
        client.once("error", reject);
      });
      return client;
    }

    it("delivers a notification_created message only to the matching user's socket", async () => {
      const mine = await connect("user-1");
      const someoneElses = await connect("user-2");

      const receivedByMine = new Promise<string>((resolve) => mine.once("message", (d) => resolve(messageText(d))));
      let othersMessage: string | undefined;
      someoneElses.once("message", (d) => {
        othersMessage = messageText(d);
      });

      await publishRealtimeMessage(pool, {
        type: "notification_created",
        userId: "user-1",
        notification: {
          id: "notif-1",
          kind: "heartbeat_error",
          title: "Heartbeat failed",
          linkHref: null,
          sourceTable: "project_heartbeats",
          sourceId: "hb-1",
          transitionInstance: "job-1",
          payload: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          readAt: null,
        },
      });

      const message = await receivedByMine;
      expect(JSON.parse(message)).toMatchObject({ type: "notification_created", userId: "user-1" });

      // Give the other socket a beat to (not) receive anything before asserting it stayed silent.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(othersMessage).toBeUndefined();

      mine.close();
      someoneElses.close();
    });

    it("never delivers a notification_read_state message to an unauthenticated socket", async () => {
      const unauthenticated = await connect(null);

      let received: string | undefined;
      unauthenticated.once("message", (d) => {
        received = messageText(d);
      });

      await publishRealtimeMessage(pool, {
        type: "notification_read_state",
        userId: "user-1",
        notificationIds: ["notif-1"],
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received).toBeUndefined();

      unauthenticated.close();
    });

    it("still broadcasts a non-user-scoped message (item_invalidation) to every connected client", async () => {
      const first = await connect("user-1");
      const second = await connect("user-2");

      const receivedByFirst = new Promise<string>((resolve) => first.once("message", (d) => resolve(messageText(d))));
      const receivedBySecond = new Promise<string>((resolve) => second.once("message", (d) => resolve(messageText(d))));

      await publishRealtimeMessage(pool, {
        type: "item_invalidation",
        databaseId: "db-1",
        itemId: "item-1",
        key: "status",
      });

      expect(JSON.parse(await receivedByFirst)).toMatchObject({ type: "item_invalidation" });
      expect(JSON.parse(await receivedBySecond)).toMatchObject({ type: "item_invalidation" });

      first.close();
      second.close();
    });
  });

  describe("startRealtimeServer with a slow resolveUserId (issue #152 PR review race)", () => {
    let httpServer: Server;
    let wss: WebSocketServer;
    let realtimeServer: RealtimeServer;
    let port: number;

    /** Settles after a macrotask, unlike a plain `Promise.resolve(...)`, to exercise the window between a socket accepting the connection and its identity actually resolving. */
    function slowResolveUserId(req: IncomingMessage): Promise<string | null> {
      const url = new URL(req.url ?? "/", "http://localhost");
      const userId = url.searchParams.get("userId");
      return new Promise((resolve) => setTimeout(() => resolve(userId), 20));
    }

    beforeEach(async () => {
      httpServer = createServer();
      wss = new WebSocketServer({ server: httpServer });
      await new Promise<void>((resolve) => httpServer.listen(0, resolve));
      const address = httpServer.address();
      if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
      port = address.port;
      realtimeServer = await startRealtimeServer(pool, wss, { resolveUserId: slowResolveUserId });
    });

    afterEach(async () => {
      await realtimeServer.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    it("still delivers a notification published before resolveUserId has settled for a just-opened socket", async () => {
      const client = new WebSocket(`ws://127.0.0.1:${port}?userId=user-1`);
      await new Promise<void>((resolve, reject) => {
        client.once("open", () => resolve());
        client.once("error", reject);
      });

      const received = new Promise<string>((resolve) => client.once("message", (d) => resolve(messageText(d))));

      // Published immediately after connect, before slowResolveUserId's 20ms delay has elapsed.
      await publishRealtimeMessage(pool, {
        type: "notification_created",
        userId: "user-1",
        notification: {
          id: "notif-1",
          kind: "heartbeat_error",
          title: "Heartbeat failed",
          linkHref: null,
          sourceTable: "project_heartbeats",
          sourceId: "hb-1",
          transitionInstance: "job-1",
          payload: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          readAt: null,
        },
      });

      expect(JSON.parse(await received)).toMatchObject({ type: "notification_created", userId: "user-1" });

      client.close();
    });
  });
});
