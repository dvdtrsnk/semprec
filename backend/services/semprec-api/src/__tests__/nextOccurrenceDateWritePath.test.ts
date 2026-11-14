import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { getTenantZeroId, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  LocalFsBlobStorageWriter,
  createUser,
  createViewTypeRegistry,
  hashPassword,
  loadFullModuleRegistry,
  login,
  seedSystem,
  type PasswordResetMailer,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

const PASSWORD = "s3cret-password";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();
const WEEKDAYS = { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri"] };

const itemBody = z
  .object({ id: z.string(), updatedAt: z.string(), properties: z.record(z.string(), z.unknown()) })
  .passthrough();
const restError = z.object({ error: z.object({ code: z.string(), details: z.record(z.string(), z.unknown()) }) });
const storedRow = z.object({ properties: z.record(z.string(), z.unknown()) });

let pool: Pool;

describe("the Events nextOccurrenceDate over REST (issue gh-1905)", () => {
  let server: Server;
  let baseUrl: string;
  let headers: Record<string, string>;
  let eventsId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM databases WHERE owner_module_id = 'events' AND system",
    );
    eventsId = rows[0]?.id ?? "";
    if (!eventsId) throw new Error("Events database not seeded");
    const user = await createUser(pool, {
      email: `${randomUUID()}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
      tenantId: getTenantZeroId(),
    });
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
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T10:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function rest(method: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${baseUrl}${path}`, { method, headers, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }

  async function storedValue(itemId: string): Promise<unknown> {
    const { rows } = await pool.query("SELECT properties FROM items WHERE database_id = $1 AND id = $2", [
      eventsId,
      itemId,
    ]);
    return storedRow.parse(rows[0]).properties.nextOccurrenceDate;
  }

  it("computes the value on a create and on a rule change", async () => {
    const created = await rest("POST", `/api/databases/${eventsId}/items`, {
      properties: { name: "Standup", date: "2026-10-12", recurrence: WEEKDAYS },
    });
    expect(created.status).toBe(201);
    const item = itemBody.parse(created.body);
    expect(item.properties.nextOccurrenceDate).toBe("2026-10-19");

    const patched = await rest("PATCH", `/api/items/${item.id}`, {
      properties: { recurrence: { kind: "weekdays", days: ["sat"] } },
      ifVersion: item.updatedAt,
    });

    expect(patched.status).toBe(200);
    expect(itemBody.parse(patched.body).properties.nextOccurrenceDate).toBe("2026-10-17");
    expect(await storedValue(item.id)).toBe("2026-10-17");
  });

  it("answers a client create that names the property with 403 and stores no Event", async () => {
    const response = await rest("POST", `/api/databases/${eventsId}/items`, {
      properties: { name: "Dentist", date: "2026-10-12", nextOccurrenceDate: "2026-12-01" },
    });

    expect(response.status).toBe(403);
    expect(restError.parse(response.body).error).toEqual({
      code: "owner_violation",
      details: { field: "nextOccurrenceDate" },
    });
    const { rows } = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM items WHERE database_id = $1",
      [eventsId],
    );
    expect(rows[0]?.count).toBe(0);
  });

  it("answers a client update that names the property with 403 and keeps the stored value", async () => {
    const created = await rest("POST", `/api/databases/${eventsId}/items`, {
      properties: { name: "Dentist", date: "2026-10-12" },
    });
    const item = itemBody.parse(created.body);

    const response = await rest("PATCH", `/api/items/${item.id}`, {
      properties: { nextOccurrenceDate: "2026-12-01" },
      ifVersion: item.updatedAt,
    });

    expect(response.status).toBe(403);
    expect(restError.parse(response.body).error).toEqual({
      code: "owner_violation",
      details: { field: "nextOccurrenceDate" },
    });
    expect(await storedValue(item.id)).toBe("2026-10-12");
  });
});
