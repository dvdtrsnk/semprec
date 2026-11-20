import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createItemWithClient, seedSystem, withTransaction } from "@semprec/data";
import {
  createGoogleCalendarWebhookRequestListener,
  createGraphCalendarWebhookRequestListener,
  GOOGLE_CALENDAR_WEBHOOK_PATH,
  GRAPH_CALENDAR_WEBHOOK_PATH,
} from "../calendarWebhookHandlers.js";

let admin: Pool;
/** The API's runtime role, under row-level security. */
let pool: Pool;
let tenantId: string;

async function createItem(moduleId: string, properties: Record<string, unknown>): Promise<string> {
  return runInTenant(tenantId, async () => {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [
      moduleId,
    ]);
    const databaseId = rows[0]?.id;
    if (databaseId === undefined) throw new Error(`Database '${moduleId}' was not seeded`);
    const item = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId, properties }));
    return item.id;
  });
}

/**
 * Plain SQL: creating channels is the maintenance's concern, covered with the providers' calls in
 * `calendarWebhooks.test.ts`; this file covers the HTTP boundary.
 */
async function registerChannel(input: {
  provider: "google" | "graph";
  channelId: string;
  accountItemId: string;
  calendarItemId: string | null;
  secret: string;
}): Promise<void> {
  await runInTenant(tenantId, () =>
    pool.query(
      `INSERT INTO calendar_push_channels (provider, channel_id, account_item_id, calendar_item_id, resource_id, secret, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + interval '1 day')`,
      [
        input.provider,
        input.channelId,
        input.accountItemId,
        input.calendarItemId,
        input.provider === "google" ? "resource-1" : null,
        input.secret,
      ],
    ),
  );
}

async function calendarSyncJobKeys(): Promise<string[]> {
  const { rows } = await runAsSystem("test", () =>
    admin.query<{ key: string }>(
      `SELECT j.key FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id
        WHERE t.identifier = 'calendarAccountSync' ORDER BY j.key`,
    ),
  );
  return rows.map((row) => row.key);
}

function listen(listener: Parameters<typeof createServer>[1]): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(listener);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected a bound TCP address"));
        return;
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

describe("calendar webhooks", () => {
  let servers: Server[] = [];
  let google: string;
  let graph: string;
  let accountItemId: string;

  beforeEach(async () => {
    admin ??= getTestPool();
    pool ??= await createRuntimeRolePool(admin, "semprec_data");
    await resetDatabase(admin);
    tenantId = await createTestTenant(admin);
    await runInTenant(tenantId, () => seedSystem(pool));
    accountItemId = await createItem("mailboxes", { name: "Account", provider: "gmail" });
    const googleServer = await listen(createGoogleCalendarWebhookRequestListener(pool));
    const graphServer = await listen(createGraphCalendarWebhookRequestListener(pool));
    servers = [googleServer.server, graphServer.server];
    google = `${googleServer.baseUrl}${GOOGLE_CALENDAR_WEBHOOK_PATH}`;
    graph = `${graphServer.baseUrl}${GRAPH_CALENDAR_WEBHOOK_PATH}`;
  });

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  describe("POST /api/calendar/google/webhook", () => {
    const channelId = randomUUID();
    const token = "a".repeat(64);

    function notify(headers: Record<string, string>, init: RequestInit = {}) {
      return fetch(google, { method: "POST", ...init, headers: { "X-Goog-Resource-State": "exists", ...headers } });
    }

    beforeEach(async () => {
      const calendarItemId = await createItem("calendars", { name: "Work", color: "#FF0000" });
      await registerChannel({ provider: "google", channelId, accountItemId, calendarItemId, secret: token });
    });

    it("answers 200 for a valid channel token and queues exactly one sync of the account", async () => {
      const headers = { "X-Goog-Channel-ID": channelId, "X-Goog-Channel-Token": token };
      const first = await notify(headers);
      expect(first.status).toBe(200);
      expect(first.headers.get("cache-control")).toBe("no-store");
      expect(await first.text()).toBe("");
      expect((await notify(headers)).status).toBe(200);
      expect(await calendarSyncJobKeys()).toEqual([`calendar-account-sync:${accountItemId}`]);
    });

    it.each<[string, () => Record<string, string>]>([
      ["an unknown channel", () => ({ "X-Goog-Channel-ID": randomUUID(), "X-Goog-Channel-Token": token })],
      ["a wrong token", () => ({ "X-Goog-Channel-ID": channelId, "X-Goog-Channel-Token": "b".repeat(64) })],
      ["no token", () => ({ "X-Goog-Channel-ID": channelId })],
      ["no channel id", () => ({ "X-Goog-Channel-Token": token })],
      ["a malformed channel id", () => ({ "X-Goog-Channel-ID": "not a channel!", "X-Goog-Channel-Token": token })],
    ])("answers the same empty 404 for %s and queues nothing", async (_name, headers) => {
      const res = await notify(headers());
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
      expect(await calendarSyncJobKeys()).toEqual([]);
    });

    it("accepts the sync message after creation without queueing a pass", async () => {
      const res = await notify({
        "X-Goog-Channel-ID": channelId,
        "X-Goog-Channel-Token": token,
        "X-Goog-Resource-State": "sync",
      });
      expect(res.status).toBe(200);
      expect(await calendarSyncJobKeys()).toEqual([]);
    });

    it("refuses an oversized body with 413 and anything but POST with 404", async () => {
      const big = await notify(
        { "X-Goog-Channel-ID": channelId, "X-Goog-Channel-Token": token },
        { body: "x".repeat(32 * 1024) },
      );
      expect(big.status).toBe(413);
      expect((await fetch(google, { method: "GET" })).status).toBe(404);
      expect(await calendarSyncJobKeys()).toEqual([]);
    });
  });

  describe("POST /api/calendar/graph/webhook", () => {
    const clientState = "c".repeat(64);

    function post(body: string, query = "") {
      return fetch(`${graph}${query}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    }

    beforeEach(async () => {
      await registerChannel({
        provider: "graph",
        channelId: "subscription-1",
        accountItemId,
        calendarItemId: null,
        secret: clientState,
      });
    });

    it("echoes the validation token as plain text before reading any body", async () => {
      const res = await post("not JSON", "?validationToken=a%20validation%20token");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await res.text()).toBe("a validation token");
      expect((await post("", `?validationToken=${"v".repeat(2000)}`)).status).toBe(400);
    });

    it("answers 202 and queues one sync for the valid notifications of a batch only", async () => {
      const res = await post(
        JSON.stringify({
          value: [
            { subscriptionId: "subscription-1", clientState, changeType: "updated" },
            { subscriptionId: "subscription-1", clientState, changeType: "created" },
            { subscriptionId: "subscription-1", clientState: "wrong" },
            { subscriptionId: "subscription-9", clientState },
            null,
          ],
        }),
      );
      expect(res.status).toBe(202);
      expect(await calendarSyncJobKeys()).toEqual([`calendar-account-sync:${accountItemId}`]);
    });

    it.each([
      ["a wrong clientState", { value: [{ subscriptionId: "subscription-1", clientState: "wrong" }] }],
      ["no clientState", { value: [{ subscriptionId: "subscription-1" }] }],
      ["an unknown subscription", { value: [{ subscriptionId: "subscription-9", clientState }] }],
      ["no batch", {}],
    ])("answers 202 for %s and queues nothing", async (_name, body) => {
      expect((await post(JSON.stringify(body))).status).toBe(202);
      expect(await calendarSyncJobKeys()).toEqual([]);
    });

    it("refuses malformed JSON with 400, an oversized body with 413 and anything but POST with 404", async () => {
      expect((await post("{not json")).status).toBe(400);
      expect((await post("[]")).status).toBe(400);
      expect((await post(JSON.stringify({ value: [], padding: "x".repeat(300 * 1024) }))).status).toBe(413);
      expect((await fetch(graph, { method: "GET" })).status).toBe(404);
      expect(await calendarSyncJobKeys()).toEqual([]);
    });
  });
});
