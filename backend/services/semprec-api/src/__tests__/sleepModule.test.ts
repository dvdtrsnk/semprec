import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createUser,
  createViewTypeRegistry,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  seedSystem,
} from "@semprec/data";
import { runInTenant } from "@semprec/shared";
import { createDispatcher } from "../app.js";

const PASSWORD = "s3cret-password";
// Each test seeds two tenants with their couple of dozen system databases and hashes two passwords.
const SEEDING_HOOK_TIMEOUT_MS = 90_000;
const SLEEP_KEYS = ["sleepSettings", "sleepPlans", "sleepNights"] as const;

const moduleRegistry = await loadFullModuleRegistry();

interface Tenant {
  id: string;
  headers: { Authorization: string };
}

const databaseBody = z.object({
  id: z.string(),
  key: z.string().nullable(),
  name: z.string(),
  searchPlaceholder: z.string().nullable(),
  ownerModuleId: z.string().nullable(),
  schemaLocked: z.boolean(),
  system: z.boolean(),
  archivedAt: z.string().nullable(),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  overviewOrder: z.number().nullable(),
  switcherOrder: z.number().nullable(),
  clientVisible: z.boolean(),
  overviewHidden: z.boolean(),
  defaultViewType: z.string().nullable(),
});
const itemBody = z.object({
  id: z.string(),
  deletedAt: z.string().nullable(),
  properties: z.record(z.string(), z.unknown()),
});
const schemaBody = z.object({
  databases: z.array(
    z.object({
      key: z.string().nullable(),
      name: z.string(),
      properties: z.array(
        z.object({
          key: z.string(),
          name: z.string(),
          options: z.array(z.object({ key: z.string(), label: z.string() })).optional(),
        }),
      ),
    }),
  ),
});

let pool: Pool;
let runtime: Pool;
let server: Server;
let base: string;
let storageDir: string;
let czech: Tenant;
let english: Tenant;

async function tenant(locale: string): Promise<Tenant> {
  const id = await createTestTenant(pool);
  const email = `${randomUUID()}@example.com`;
  await createUser(pool, { tenantId: id, email, passwordHash: await hashPassword(PASSWORD), locale });
  const { token } = await login(pool, { email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  await runInTenant(id, () => seedSystem(runtime, createViewTypeRegistry()));
  return { id, headers: { Authorization: `Bearer ${token}` } };
}

async function request(
  who: Tenant,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...who.headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

async function listDatabases(who: Tenant): Promise<Array<z.infer<typeof databaseBody>>> {
  const { status, body } = await request(who, "GET", "/api/databases?limit=200");
  expect(status).toBe(200);
  return z.object({ databases: z.array(databaseBody) }).parse(body).databases;
}

async function database(who: Tenant, key: string): Promise<z.infer<typeof databaseBody>> {
  const found = (await listDatabases(who)).find((entry) => entry.key === key);
  if (!found) throw new Error(`${key} is missing from GET /api/databases`);
  return found;
}

/** The live items of a database, through `POST /api/databases/:id/query`. */
async function items(who: Tenant, databaseId: string): Promise<Array<z.infer<typeof itemBody>>> {
  const { status, body } = await request(who, "POST", `/api/databases/${databaseId}/query`, { limit: 200 });
  expect(status).toBe(200);
  return z.object({ items: z.array(itemBody) }).parse(body).items;
}

async function planNames(who: Tenant): Promise<unknown[]> {
  const plans = await database(who, "sleepPlans");
  return (await items(who, plans.id)).map((plan) => plan.properties.name).sort();
}

/** The labels `GET /api/schema` answers `who` for the sleep databases: database names and the alarm sound options. */
async function schemaLabels(who: Tenant) {
  const { status, body } = await request(who, "GET", "/api/schema");
  expect(status).toBe(200);
  const databases = schemaBody.parse(body).databases;
  const settings = databases.find((entry) => entry.key === "sleepSettings");
  return {
    names: SLEEP_KEYS.map((key) => databases.find((entry) => entry.key === key)?.name),
    alarmSound: settings?.properties.find((entry) => entry.key === "alarmSound"),
  };
}

describe("sleep module over HTTP (issue #1776)", () => {
  beforeAll(async () => {
    pool = getTestPool();
    runtime = await createRuntimeRolePool(pool, "semprec_data");
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    storageDir = join(tmpdir(), `semprec-sleep-${randomUUID()}`);
    server = createServer(
      await createDispatcher(runtime, {
        moduleRegistry,
        passwordResetMailer: { async sendPasswordResetEmail() {} },
        appBaseUrl: "http://localhost",
        setupToken: "unused-setup-token",
        blobStorage: new LocalFsBlobStorageWriter(storageDir),
        maxFileSizeBytes: 1048576,
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    base = `http://127.0.0.1:${address.port}`;
    czech = await tenant("cs");
    english = await tenant("en");
  }, SEEDING_HOOK_TIMEOUT_MS);

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(storageDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await runtime?.end();
    await pool?.end();
  });

  it("returns the three sleep databases from GET /api/databases as locked system databases with clientVisible false and no overview or switcher order", async () => {
    const all = await listDatabases(czech);
    const sleep = all.filter((entry) => entry.ownerModuleId?.startsWith("sleep"));

    expect(sleep.map((entry) => entry.key).sort()).toEqual([...SLEEP_KEYS].sort());
    const names: Record<string, string> = {
      sleepSettings: "Nastavení spánku",
      sleepPlans: "Plány spánku",
      sleepNights: "Noci spánku",
    };
    for (const entry of sleep) {
      expect(entry).toEqual({
        id: entry.id,
        key: entry.key,
        name: names[entry.key ?? ""],
        searchPlaceholder: null,
        ownerModuleId: entry.key,
        schemaLocked: true,
        system: true,
        archivedAt: null,
        icon: null,
        color: null,
        overviewOrder: null,
        switcherOrder: null,
        clientVisible: false,
        overviewHidden: false,
        defaultViewType: null,
      });
      const detail = await request(czech, "GET", `/api/databases/${entry.id}`);
      expect(detail.status).toBe(200);
      expect(databaseBody.parse(detail.body)).toEqual(entry);
    }

    const inEnglish = (await listDatabases(english)).filter((entry) => entry.ownerModuleId?.startsWith("sleep"));
    expect(Object.fromEntries(inEnglish.map((entry) => [entry.key, entry.name]))).toEqual({
      sleepSettings: "Sleep settings",
      sleepPlans: "Sleep plans",
      sleepNights: "Sleep nights",
    });
    expect(inEnglish.every((entry) => entry.clientVisible === false)).toBe(true);
    // The other tenant has its own three databases.
    expect(inEnglish.map((entry) => entry.id).filter((id) => sleep.some((entry) => entry.id === id))).toEqual([]);
  });

  it("answers DELETE /api/items/:id of the settings item with 403 and field systemActive, and keeps the item", async () => {
    const settings = await database(czech, "sleepSettings");
    const [item] = await items(czech, settings.id);
    if (!item) throw new Error("The seed left no settings item");

    const refused = await request(czech, "DELETE", `/api/items/${item.id}`);

    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: { code: "forbidden", details: { field: "systemActive" } } });
    expect(await items(czech, settings.id)).toEqual([item]);
    const read = await request(czech, "GET", `/api/items/${item.id}`);
    expect(read.status).toBe(200);
    expect(itemBody.parse(read.body)).toEqual(item);
  });

  it("moves a plan and a night item to the trash through DELETE /api/items/:id", async () => {
    const plans = await database(czech, "sleepPlans");
    const nights = await database(czech, "sleepNights");
    const [plan, otherPlan] = await items(czech, plans.id);
    if (!plan || !otherPlan) throw new Error("The seed left fewer than two plans");
    const created = await request(czech, "POST", `/api/databases/${nights.id}/items`, {
      properties: { night: "2026-10-16", wakeTime: "07:30" },
    });
    expect(created.status).toBe(201);
    const night = itemBody.parse(created.body);
    expect(await items(czech, nights.id)).toEqual([night]);

    const deletedPlan = await request(czech, "DELETE", `/api/items/${plan.id}`);
    const deletedNight = await request(czech, "DELETE", `/api/items/${night.id}`);

    expect(deletedPlan.status).toBe(200);
    expect(itemBody.parse(deletedPlan.body)).toMatchObject({ id: plan.id, deletedAt: expect.any(String) });
    expect(deletedNight.status).toBe(200);
    expect(itemBody.parse(deletedNight.body)).toMatchObject({ id: night.id, deletedAt: expect.any(String) });
    expect(await items(czech, plans.id)).toEqual([otherPlan]);
    expect(await items(czech, nights.id)).toEqual([]);
    // The other tenant's plans are untouched.
    expect(await planNames(english)).toEqual(["Weekdays", "Weekend"]);
  });

  it("labels the alarmSound options in Czech for a Czech user and in English for an English user in GET /api/schema", async () => {
    expect(await schemaLabels(czech)).toEqual({
      names: ["Nastavení spánku", "Plány spánku", "Noci spánku"],
      alarmSound: {
        key: "alarmSound",
        name: "Zvuk budíku",
        options: [
          { key: "morning", label: "Ráno" },
          { key: "birds", label: "Ptáci" },
          { key: "piano", label: "Klavír" },
          { key: "vibrateOnly", label: "Pouze vibrace" },
        ],
      },
    });
    expect(await schemaLabels(english)).toEqual({
      names: ["Sleep settings", "Sleep plans", "Sleep nights"],
      alarmSound: {
        key: "alarmSound",
        name: "Alarm sound",
        options: [
          { key: "morning", label: "Morning" },
          { key: "birds", label: "Birds" },
          { key: "piano", label: "Piano" },
          { key: "vibrateOnly", label: "Vibrate only" },
        ],
      },
    });
  });

  it("keeps the plan names a Czech tenant was seeded with after the user switches the profile to English, while the schema labels switch", async () => {
    expect(await planNames(czech)).toEqual(["Pracovní dny", "Víkend"]);
    expect(await planNames(english)).toEqual(["Weekdays", "Weekend"]);

    const switched = await request(czech, "PATCH", "/api/account/profile", { locale: "en" });

    expect(switched.status).toBe(200);
    expect(z.object({ user: z.object({ locale: z.string() }) }).parse(switched.body).user.locale).toBe("en");
    expect(await planNames(czech)).toEqual(["Pracovní dny", "Víkend"]);
    expect((await schemaLabels(czech)).alarmSound?.options?.map((option) => option.label)).toEqual([
      "Morning",
      "Birds",
      "Piano",
      "Vibrate only",
    ]);
  });
});
