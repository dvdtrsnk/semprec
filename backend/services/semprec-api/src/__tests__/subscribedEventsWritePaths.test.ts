import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { getTenantZeroId, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  CALENDAR_MODULE_ID,
  createChokePoint,
  createItemWithClient,
  createUser,
  createViewTypeRegistry,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  seedSystem,
  withTransaction,
  type PasswordResetMailer,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

const PASSWORD = "s3cret-password";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();

const ROW = {
  uid: "event-1@example.com",
  title: "Quarterly review",
  startsAt: "2026-10-20T15:00",
  endsAt: "2026-10-20T16:00",
  timeZone: "America/New_York",
  allDay: false,
  place: "Room 4",
};

const restError = z.object({
  error: z.object({ code: z.string(), details: z.record(z.string(), z.unknown()) }).strict(),
});
/** What `/mcp` answers: a JSON-RPC result, or an error that carries the operation's error code in `data`. */
const rpcBody = z.object({
  result: z.object({ content: z.array(z.object({ text: z.string() })) }).optional(),
  error: z
    .object({ code: z.number(), message: z.string(), data: z.object({ code: z.string() }).optional() })
    .optional(),
});

let pool: Pool;

/**
 * The generic write routes of the production dispatcher, REST and `/mcp`, against the read-only
 * `subscribedEvents` database (issue gh-1962): a user's token is refused on every property, and a row written
 * by the calendar module with its system owner process stays as it was.
 */
describe("the generic write routes refuse the subscribedEvents database (issue gh-1962)", () => {
  let server: Server;
  let baseUrl: string;
  let headers: Record<string, string>;
  let subscribedEventsId: string;
  let rowId: string;
  let rowVersion: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    const user = await createUser(pool, {
      email: `${randomUUID()}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
      tenantId: getTenantZeroId(),
      locale: "en",
    });
    await seedSystem(pool, createViewTypeRegistry());
    const chokePoint = createChokePoint(pool);
    const database = (await chokePoint.listDatabases()).find(
      (candidate) => candidate.ownerModuleId === "subscribedEvents",
    );
    if (!database) throw new Error("Missing the subscribedEvents database");
    subscribedEventsId = database.id;
    const properties = await chokePoint.listProperties(subscribedEventsId);
    // The write the later feed import makes: the system writer with the calendar module's owner process.
    const row = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: subscribedEventsId, properties: ROW },
        {
          allowedSystemKeys: properties.filter((p) => p.type !== "relation").map((p) => p.key),
          systemOwnerProcess: CALENDAR_MODULE_ID,
        },
      ),
    );
    rowId = row.id;
    rowVersion = row.updatedAt;

    const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    server = createServer(
      await createDispatcher(pool, {
        passwordResetMailer: noopMailer,
        appBaseUrl: "http://localhost",
        setupToken: "unused-setup-token",
        moduleRegistry,
        blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
        maxFileSizeBytes: 10 * 1024 * 1024,
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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

  /** A refusal as REST exposes it: the HTTP status and the error body's `code` and `details`. */
  async function restRefusal(method: string, path: string, body: unknown) {
    const res = await fetch(`${baseUrl}${path}`, { method, headers, body: JSON.stringify(body) });
    const parsed = restError.parse(await res.json());
    return { status: res.status, code: parsed.error.code, details: parsed.error.details };
  }

  async function mcp(name: string, args: unknown) {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    expect(res.status).toBe(200);
    return rpcBody.parse(await res.json());
  }

  async function storedRows() {
    return (await createChokePoint(pool).listItems(subscribedEventsId, { limit: 50 })).items;
  }

  it("answers POST /api/databases/:id/items with 403 and stores no second row", async () => {
    expect(
      await restRefusal("POST", `/api/databases/${subscribedEventsId}/items`, {
        properties: { ...ROW, uid: "event-2@example.com" },
      }),
    ).toMatchObject({ status: 403, code: "owner_violation" });
    expect((await storedRows()).map((item) => item.id)).toEqual([rowId]);
  });

  it.each([
    ["no body property", {}],
    ["an empty properties object", { properties: {} }],
  ])("answers POST /api/databases/:id/items with %s with 403 and stores no blank row", async (_name, body) => {
    expect(await restRefusal("POST", `/api/databases/${subscribedEventsId}/items`, body)).toEqual({
      status: 403,
      code: "owner_violation",
      details: { field: "databaseId" },
    });
    expect((await storedRows()).map((item) => item.id)).toEqual([rowId]);
  });

  it("answers PATCH /api/items/:id with an empty properties object with 403 and keeps the row", async () => {
    expect(await restRefusal("PATCH", `/api/items/${rowId}`, { properties: {}, ifVersion: rowVersion })).toEqual({
      status: 403,
      code: "owner_violation",
      details: { field: "databaseId" },
    });
    const [row] = await storedRows();
    expect(row).toMatchObject({ id: rowId, properties: ROW, updatedAt: rowVersion });
  });

  it("answers semprec.item.create over /mcp with an empty properties object with a refusal and stores no blank row", async () => {
    const body = await mcp("semprec.item.create", { databaseId: subscribedEventsId, properties: {} });
    expect(body.result).toBeUndefined();
    expect(body.error).toMatchObject({ data: { code: "owner_violation" } });
    expect((await storedRows()).map((item) => item.id)).toEqual([rowId]);
  });

  it("answers PATCH /api/items/:id of a row the calendar module wrote with 403 and keeps the row", async () => {
    expect(
      await restRefusal("PATCH", `/api/items/${rowId}`, { properties: { title: "Renamed" }, ifVersion: rowVersion }),
    ).toEqual({ status: 403, code: "owner_violation", details: { field: "title" } });
    expect((await storedRows()).map((item) => item.properties)).toEqual([ROW]);
  });

  it("answers semprec.item.create over /mcp with a refusal and stores no second row", async () => {
    const body = await mcp("semprec.item.create", {
      databaseId: subscribedEventsId,
      properties: { ...ROW, uid: "event-2@example.com" },
    });
    expect(body.result).toBeUndefined();
    expect(body.error).toMatchObject({ data: { code: "owner_violation" } });
    expect((await storedRows()).map((item) => item.id)).toEqual([rowId]);
  });

  it("answers semprec.item.patch over /mcp of a row the calendar module wrote with a refusal and keeps the row", async () => {
    const body = await mcp("semprec.item.patch", {
      itemId: rowId,
      properties: { title: "Renamed" },
      ifVersion: rowVersion,
    });
    expect(body.result).toBeUndefined();
    expect(body.error).toMatchObject({ data: { code: "owner_violation" } });
    expect((await storedRows()).map((item) => item.properties)).toEqual([ROW]);
  });
});
