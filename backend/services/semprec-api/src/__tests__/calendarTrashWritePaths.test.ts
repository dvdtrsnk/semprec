import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { getTenantZeroId, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createChokePoint,
  createUser,
  createViewTypeRegistry,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  seedSystem,
  type PasswordResetMailer,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

const PASSWORD = "s3cret-password";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();

const itemBody = z
  .object({ id: z.string(), deletedAt: z.string().nullable(), properties: z.record(z.string(), z.unknown()) })
  .passthrough();
const restError = z.object({
  error: z.object({ code: z.string(), details: z.record(z.string(), z.unknown()) }).strict(),
});
const calendarRow = z.object({
  id: z.string(),
  updatedAt: z.string(),
  properties: z.object({ name: z.string(), isDefault: z.boolean().optional() }).passthrough(),
});

let pool: Pool;

/**
 * The trash and restore of a calendar (issue gh-1803) as a client meets them: the generic item routes of the
 * production dispatcher, with the hooks that `@semprec/data` registers on import.
 */
describe("the generic item routes trash and restore a calendar with its Events (issue gh-1803)", () => {
  let server: Server;
  let baseUrl: string;
  let headers: Record<string, string>;
  let calendarsId: string;
  let eventsId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    const user = await createUser(pool, {
      email: `${randomUUID()}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
      tenantId: getTenantZeroId(),
      locale: "en",
    });
    // Seeded after the English-speaking user exists, so the calendars are named `Personal`, `Work` and so on.
    await seedSystem(pool, createViewTypeRegistry());
    const calendars = (await createChokePoint(pool).listDatabases()).find(
      (database) => database.ownerModuleId === "calendars",
    );
    if (!calendars) throw new Error("Missing the calendars database");
    calendarsId = calendars.id;
    const events = (await createChokePoint(pool).listDatabases()).find(
      (database) => database.ownerModuleId === "events",
    );
    if (!events) throw new Error("Missing the events database");
    eventsId = events.id;

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

  async function request(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json() };
  }

  /** A refusal as REST exposes it: the HTTP status and the error body's `code` and `details`. */
  async function refusal(method: string, path: string) {
    const response = await request(method, path);
    const parsed = restError.parse(response.body);
    return { status: response.status, code: parsed.error.code, details: parsed.error.details };
  }

  /** The live calendars as stored. */
  async function calendars() {
    return z.array(calendarRow).parse((await createChokePoint(pool).listItems(calendarsId, { limit: 50 })).items);
  }

  async function calendar(name: string) {
    const row = (await calendars()).find((candidate) => candidate.properties.name === name);
    if (!row) throw new Error(`Missing calendar ${name}`);
    return row;
  }

  /** The ids of the live Events as stored. */
  async function liveEventIds(): Promise<string[]> {
    return (await createChokePoint(pool).listItems(eventsId, { limit: 50 })).items.map((item) => item.id);
  }

  /** Creates an Event in the default calendar through the generic route. */
  async function createEvent(name: string): Promise<string> {
    const created = await request("POST", `/api/databases/${eventsId}/items`, {
      properties: { name, date: "2026-11-16" },
    });
    expect(created.status).toBe(201);
    return itemBody.parse(created.body).id;
  }

  it.each(["Sleep", "Birthdays"])("answers the delete of the system calendar %s with 403 forbidden", async (name) => {
    const row = await calendar(name);

    expect(await refusal("DELETE", `/api/items/${row.id}`)).toEqual({
      status: 403,
      code: "forbidden",
      details: { field: "kind" },
    });
    expect((await calendars()).map((candidate) => candidate.id)).toContain(row.id);
  });

  it("answers the delete of the last own calendar with 409 last_own_calendar and trashes it with nothing", async () => {
    const eventId = await createEvent("Standup");
    for (const name of ["Work", "Family", "Health"]) {
      const deleted = await request("DELETE", `/api/items/${(await calendar(name)).id}`);
      expect(deleted.status).toBe(200);
    }
    const personal = await calendar("Personal");

    const refused = await refusal("DELETE", `/api/items/${personal.id}`);

    expect(refused).toMatchObject({ status: 409, code: "last_own_calendar" });
    expect((await calendars()).map((candidate) => candidate.id)).toContain(personal.id);
    expect(await liveEventIds()).toEqual([eventId]);
  });

  it("trashes the default calendar with its Events, moves the default, and restores both", async () => {
    const personal = await calendar("Personal");
    const eventId = await createEvent("Standup");

    const deleted = await request("DELETE", `/api/items/${personal.id}`);
    expect(deleted.status).toBe(200);
    expect(itemBody.parse(deleted.body).deletedAt).not.toBeNull();
    expect(await liveEventIds()).toEqual([]);
    const defaults = (await calendars()).filter((row) => row.properties.isDefault === true);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.id).not.toBe(personal.id);

    const restored = await request("POST", `/api/items/${personal.id}/restore`);
    expect(restored.status).toBe(200);
    expect(await liveEventIds()).toEqual([eventId]);
    const restoredRow = (await calendars()).find((row) => row.id === personal.id);
    expect(restoredRow?.properties.isDefault).toBe(false);
    expect((await calendars()).filter((row) => row.properties.isDefault === true).map((row) => row.id)).toEqual([
      defaults[0]?.id,
    ]);
  });
});
