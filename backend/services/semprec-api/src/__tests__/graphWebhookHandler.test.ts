import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createItemWithClient, seedSystem, withTransaction } from "@semprec/data";
import { createGraphWebhookRequestListener } from "../graphWebhookHandler.js";

let pool: Pool;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function createMailboxItem(name: string): Promise<string> {
  const mailboxesId = await databaseIdFor("mailboxes");
  const item = await withTransaction(pool, (client) =>
    createItemWithClient(client, { databaseId: mailboxesId, properties: { name, provider: "outlook" } }),
  );
  return item.id;
}

/** Sets up `mail_account_sync_state` directly with plain SQL: registering a subscription is `graphWebhookLifecycle.ts`'s own concern (covered by its own package test), not something this HTTP-boundary test needs to exercise through it. */
async function registerSubscription(mailboxItemId: string, subscriptionId: string, clientState: string): Promise<void> {
  await pool.query(
    `INSERT INTO mail_account_sync_state (item_id, sync_mode, graph_subscription_id, graph_subscription_expires_at, graph_client_state)
     VALUES ($1, 'graph_api', $2, now() + interval '1 day', $3)`,
    [mailboxItemId, subscriptionId, clientState],
  );
}

async function pendingMailSyncJobCount(mailboxItemId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM graphile_worker._private_jobs j
     JOIN graphile_worker._private_tasks t ON t.id = j.task_id
     WHERE t.identifier = 'mailAccountSync' AND j.key = $1`,
    [`mail-account-sync:${mailboxItemId}`],
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * HTTP-level tests for `POST /api/mail/graph/webhook` (issue #198). `graphWebhookLifecycle.test.ts`
 * (packages/data) covers the subscription registration/renewal lifecycle and
 * `handleGraphChangeNotification`'s own dedup/rejection behavior directly; this file covers only
 * what's specific to the HTTP boundary — the validation handshake, request parsing, and response
 * codes.
 */
describe("createGraphWebhookRequestListener (issue #198)", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);

    server = createServer(createGraphWebhookRequestListener(pool));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("echoes the validation token back as plain text within three seconds", async () => {
    const start = Date.now();
    const res = await fetch(
      `${baseUrl}/api/mail/graph/webhook?validationToken=${encodeURIComponent("a-validation-token")}`,
      {
        method: "POST",
      },
    );
    const elapsedMs = Date.now() - start;

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("a-validation-token");
    expect(elapsedMs).toBeLessThan(3000);
  });

  it("never treats a validation POST's body as a notification batch", async () => {
    const res = await fetch(`${baseUrl}/api/mail/graph/webhook?validationToken=tok`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "this is not JSON at all",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("tok");
  });

  it("accepts a valid notification and durably hands it off to the idempotent sync job", async () => {
    const mailboxItemId = await createMailboxItem("A");
    await registerSubscription(mailboxItemId, "sub-1", "secret-state");

    const res = await fetch(`${baseUrl}/api/mail/graph/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        value: [{ subscriptionId: "sub-1", clientState: "secret-state", changeType: "updated" }],
      }),
    });

    expect(res.status).toBe(202);
    expect(await pendingMailSyncJobCount(mailboxItemId)).toBe(1);
  });

  it("deduplicates repeated notifications for the same account into one job", async () => {
    const mailboxItemId = await createMailboxItem("B");
    await registerSubscription(mailboxItemId, "sub-2", "secret-state");

    const body = JSON.stringify({
      value: [
        { subscriptionId: "sub-2", clientState: "secret-state" },
        { subscriptionId: "sub-2", clientState: "secret-state" },
      ],
    });
    const res = await fetch(`${baseUrl}/api/mail/graph/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    expect(res.status).toBe(202);
    expect(await pendingMailSyncJobCount(mailboxItemId)).toBe(1);
  });

  it("rejects a notification with a wrong clientState — 202 to Graph, but no job enqueued", async () => {
    const mailboxItemId = await createMailboxItem("C");
    await registerSubscription(mailboxItemId, "sub-3", "secret-state");

    const res = await fetch(`${baseUrl}/api/mail/graph/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: [{ subscriptionId: "sub-3", clientState: "wrong-state" }] }),
    });

    expect(res.status).toBe(202);
    expect(await pendingMailSyncJobCount(mailboxItemId)).toBe(0);
  });

  it("rejects a notification for a subscriptionId this deployment never registered", async () => {
    const res = await fetch(`${baseUrl}/api/mail/graph/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: [{ subscriptionId: "unknown-subscription", clientState: "whatever" }] }),
    });
    expect(res.status).toBe(202);
  });

  it("returns 400 for a malformed JSON body", async () => {
    const res = await fetch(`${baseUrl}/api/mail/graph/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 202 for an empty/absent notification batch", async () => {
    const res = await fetch(`${baseUrl}/api/mail/graph/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(202);
  });

  it("returns 413 for an oversized body", async () => {
    const res = await fetch(`${baseUrl}/api/mail/graph/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: [], padding: "x".repeat(300 * 1024) }),
    });
    expect(res.status).toBe(413);
  });

  it("returns 404 for a non-POST request", async () => {
    const res = await fetch(`${baseUrl}/api/mail/graph/webhook`, { method: "GET" });
    expect(res.status).toBe(404);
  });
});
