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

const itemBody = z.object({ id: z.string(), properties: z.record(z.string(), z.unknown()) }).passthrough();
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
 * The calendar row rules of issue #1778 as a client meets them: the generic item routes of the production
 * dispatcher, with the hooks that `@semprec/data` registers on import.
 */
describe("the generic item routes apply the calendar row rules (issue #1778)", () => {
  let server: Server;
  let baseUrl: string;
  let headers: Record<string, string>;
  let calendarsId: string;

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

  async function rest(method: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${baseUrl}${path}`, { method, headers, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }

  /** A refusal as REST exposes it: the HTTP status and the error body's `code` and `details`. */
  async function refusal(method: string, path: string, body: unknown) {
    const response = await rest(method, path, body);
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

  /** The names of the live calendars whose `isDefault` is true. */
  async function defaultNames(): Promise<string[]> {
    return (await calendars()).filter((row) => row.properties.isDefault === true).map((row) => row.properties.name);
  }

  /** The PATCH a client sends for the calendar `name`: the properties and the version it read. */
  async function patchRequest(name: string, properties: Record<string, unknown>) {
    const row = await calendar(name);
    return { path: `/api/items/${row.id}`, body: { properties, ifVersion: row.updatedAt } };
  }

  async function patch(name: string, properties: Record<string, unknown>) {
    const request = await patchRequest(name, properties);
    return rest("PATCH", request.path, request.body);
  }

  async function patchRefusal(name: string, properties: Record<string, unknown>) {
    const request = await patchRequest(name, properties);
    return refusal("PATCH", request.path, request.body);
  }

  it("answers the rename of a system calendar with 403 forbidden on name and renames an own calendar", async () => {
    expect(await patchRefusal("Birthdays", { name: "Mine" })).toEqual({
      status: 403,
      code: "forbidden",
      details: { field: "name" },
    });
    expect((await calendars()).map((row) => row.properties.name)).toContain("Birthdays");

    const renamed = await patch("Work", { name: "Office" });
    expect(renamed.status).toBe(200);
    expect(itemBody.parse(renamed.body).properties.name).toBe("Office");
    expect((await calendars()).map((row) => row.properties.name)).toContain("Office");
  });

  it.each(["blue", "#FFF", null])("answers the colour %j with 400 validation_failed on color", async (color) => {
    const before = await calendars();
    expect(await patchRefusal("Work", { color })).toEqual({
      status: 400,
      code: "validation_failed",
      details: { field: "color" },
    });
    expect(
      await refusal("POST", `/api/databases/${calendarsId}/items`, { properties: { name: "Club", color } }),
    ).toEqual({ status: 400, code: "validation_failed", details: { field: "color" } });
    expect(await calendars()).toEqual(before);
  });

  it("stores the colour #FF9500", async () => {
    const patched = await patch("Work", { color: "#FF9500" });
    expect(patched.status).toBe(200);
    expect(itemBody.parse(patched.body).properties.color).toBe("#FF9500");
  });

  it("moves the default to Work and leaves exactly one default", async () => {
    expect(await defaultNames()).toEqual(["Personal"]);

    const patched = await patch("Work", { isDefault: true });
    expect(patched.status).toBe(200);
    expect(await defaultNames()).toEqual(["Work"]);
    expect((await calendar("Personal")).properties.isDefault).toBe(false);
  });

  it("makes a calendar created with isDefault true the only default", async () => {
    const created = await rest("POST", `/api/databases/${calendarsId}/items`, {
      properties: { name: "Club", color: "#FF9500", isDefault: true },
    });
    expect(created.status).toBe(201);
    expect(await defaultNames()).toEqual(["Club"]);
  });

  it("answers isDefault on a system calendar, and clearing the only default, with 400 on isDefault", async () => {
    const refused = { status: 400, code: "validation_failed", details: { field: "isDefault" } };
    expect(await patchRefusal("Birthdays", { isDefault: true })).toEqual(refused);
    expect(await patchRefusal("Personal", { isDefault: false })).toEqual(refused);
    expect(await defaultNames()).toEqual(["Personal"]);
  });

  it.each(["kind", "systemKey"])("answers a write of %s with 403", async (key) => {
    const before = await calendars();
    const refused = { status: 403, code: "owner_violation", details: { field: key } };
    expect(await patchRefusal("Work", { [key]: "system" })).toEqual(refused);
    expect(
      await refusal("POST", `/api/databases/${calendarsId}/items`, { properties: { name: "Mine", [key]: "system" } }),
    ).toEqual(refused);
    expect(await calendars()).toEqual(before);
  });
});
