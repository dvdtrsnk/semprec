import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createChokePoint,
  createRelationWithClient,
  createTaskRecurrence,
  createUser,
  createViewTypeRegistry,
  ensureJournalPeriodDoc,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  seedSystem,
  setInvalidationHook,
  updateItemWithClient,
  withTransaction,
  type InvalidationEvent,
  type PasswordResetMailer,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

/**
 * Batch 34 entry-point contracts (gh-1605, gh-1609, gh-2016, gh-1622) through the production dispatcher: real
 * session authentication, the generic REST routes, the application service and the choke point, on a runtime-role
 * pool that row-level security applies to, with two tenants.
 */

const PASSWORD = "s3cret-password";
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();

const errorBody = z.object({
  error: z.object({ code: z.string(), details: z.unknown().optional() }),
});
const itemEnvelope = z.object({
  id: z.string(),
  databaseId: z.string(),
  properties: z.record(z.string(), z.unknown()),
  updatedAt: z.string(),
});
const propertyEnvelope = z.object({ id: z.string(), key: z.string(), config: z.record(z.string(), z.unknown()) });

let admin: Pool;
let runtime: Pool;
let server: Server;
let base: string;
let invalidations: InvalidationEvent[];

interface TenantFixture {
  id: string;
  headers: Record<string, string>;
  databases: Record<string, string>;
}

async function tenantWithUser(): Promise<TenantFixture> {
  const id = await createTestTenant(admin);
  const email = `${randomUUID()}@example.com`;
  await createUser(admin, { tenantId: id, email, passwordHash: await hashPassword(PASSWORD) });
  const { token } = await login(admin, { email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  await runInTenant(id, () => seedSystem(runtime, createViewTypeRegistry()));
  const databases = await runInTenant(id, async () =>
    Object.fromEntries(
      (await createChokePoint(runtime).listDatabases()).flatMap((db) =>
        db.ownerModuleId === null ? [] : [[db.ownerModuleId, db.id] as const],
      ),
    ),
  );
  return { id, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, databases };
}

async function call(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text === "" ? null : (JSON.parse(text) as unknown) };
}

function databaseOf(tenant: TenantFixture, moduleId: string): string {
  const id = tenant.databases[moduleId];
  if (id === undefined) throw new Error(`Missing ${moduleId} database`);
  return id;
}

const property = async (tenant: TenantFixture, moduleId: string, key: string) => {
  const found = await runInTenant(tenant.id, async () =>
    (await createChokePoint(runtime).listProperties(databaseOf(tenant, moduleId))).find((p) => p.key === key),
  );
  if (!found) throw new Error(`Missing ${moduleId}.${key}`);
  return found;
};

function ownerProcessOf(found: { key: string; ownerProcess: string | null }): string {
  if (found.ownerProcess === null) throw new Error(`${found.key} has no owner process`);
  return found.ownerProcess;
}

describe("batch 34 entry-point contracts", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const dispatch = await createDispatcher(runtime, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "http://localhost",
      setupToken: "unused-setup-token",
      moduleRegistry,
      blobStorage: new LocalFsBlobStorageWriter(join(tmpdir(), `semprec-batch34-${randomUUID()}`)),
      maxFileSizeBytes: 10 * 1024 * 1024,
    });
    server = createServer(dispatch);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a bound TCP address");
    base = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    invalidations = [];
    setInvalidationHook((event) => invalidations.push(event));
  });
  afterEach(() => {
    setInvalidationHook(() => {});
  });
  afterAll(async () => {
    const failures: unknown[] = [];
    if (server?.listening) {
      try {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      } catch (error) {
        failures.push(error);
      }
    }
    for (const owned of [runtime, admin]) {
      try {
        await owned?.end();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Batch 34 contract fixture cleanup failed");
  });

  it("gh-1605: GET returns the series fields and a client PATCH of each is refused with 403 owner_violation", async () => {
    const own = await tenantWithUser();
    const foreign = await tenantWithUser();
    const seriesProperty = await property(own, "tasks", "seriesId");
    const rule = { kind: "weekdays" as const, days: ["mon" as const] };
    const task = await runInTenant(own.id, async () => {
      const cp = createChokePoint(runtime);
      const created = await cp.createItem({
        databaseId: databaseOf(own, "tasks"),
        properties: { name: "Weekly review", date: "2026-10-12" },
      });
      // The recurrence route (#1665) is not built yet, so the series is created through the Tasks store's public
      // `createTaskRecurrence` and the Tasks owner's system choke-point write of the three series properties.
      await withTransaction(runtime, async (client) => {
        const series = await createTaskRecurrence(client, {
          itemId: created.id,
          mode: "fixed",
          rule,
          anchorDate: "2026-10-12",
          template: {
            name: "Weekly review",
            timeFrom: null,
            timeTo: null,
            notifications: false,
            persistent: false,
            flagged: false,
            description: null,
          },
        });
        await updateItemWithClient(
          client,
          {
            databaseId: databaseOf(own, "tasks"),
            itemId: created.id,
            propertiesPatch: {
              seriesId: series.seriesId,
              occurrenceDate: "2026-10-12",
              recurrence: { preset: "weekly", mode: "fixed", rule },
            },
          },
          {
            allowedSystemKeys: ["seriesId", "occurrenceDate", "recurrence"],
            systemOwnerProcess: ownerProcessOf(seriesProperty),
          },
        );
      });
      return created;
    });

    const read = await call("GET", `/api/items/${task.id}`, own.headers);
    expect(read.status).toBe(200);
    const before = itemEnvelope.parse(read.json);
    expect(before.properties).toMatchObject({
      seriesId: expect.any(String),
      occurrenceDate: "2026-10-12",
      recurrence: { preset: "weekly", mode: "fixed", rule },
    });
    const recurrenceRows = () =>
      runInTenant(
        own.id,
        async () =>
          (
            await runtime.query<{
              item_id: string;
              series_id: string | null;
              anchor_date: string | null;
              template: unknown;
            }>(
              "SELECT item_id, series_id, anchor_date::text AS anchor_date, template FROM task_recurrence ORDER BY item_id",
            )
          ).rows,
      );
    const rowsBefore = await recurrenceRows();
    expect(rowsBefore).toEqual([
      {
        item_id: task.id,
        series_id: before.properties.seriesId,
        anchor_date: "2026-10-12",
        template: expect.any(Object),
      },
    ]);
    invalidations = [];
    for (const patch of [
      { seriesId: randomUUID() },
      { occurrenceDate: "2026-10-19" },
      { recurrence: { preset: null, mode: "fixed", rule } },
    ]) {
      const refused = await call("PATCH", `/api/items/${task.id}`, own.headers, {
        properties: patch,
        ifVersion: before.updatedAt,
      });
      expect(refused.status).toBe(403);
      expect(errorBody.parse(refused.json).error).toMatchObject({
        code: "owner_violation",
        details: { field: Object.keys(patch)[0] },
      });
    }
    const after = await call("GET", `/api/items/${task.id}`, own.headers);
    expect(itemEnvelope.parse(after.json)).toEqual(before);
    expect(await recurrenceRows()).toEqual(rowsBefore);
    expect(invalidations).toEqual([]);

    const foreignRead = await call("GET", `/api/items/${task.id}`, foreign.headers);
    const randomRead = await call("GET", `/api/items/${randomUUID()}`, foreign.headers);
    expect(foreignRead.status).toBe(404);
    expect(randomRead.status).toBe(404);
    expect(errorBody.parse(foreignRead.json).error.code).toBe(errorBody.parse(randomRead.json).error.code);
  });

  it("gh-1609/gh-2016: a user cannot create or delete Journal events edges through the generic relation endpoint", async () => {
    const own = await tenantWithUser();
    const foreign = await tenantWithUser();
    const eventsProperty = await property(own, "journal", "events");
    const fixture = await runInTenant(own.id, async () => {
      const cp = createChokePoint(runtime);
      const day = await withTransaction(runtime, (client) => ensureJournalPeriodDoc(client, "day", "2026-10-16"));
      const standup = await cp.createItem({ databaseId: databaseOf(own, "events"), properties: { name: "Standup" } });
      const linked = await cp.createItem({ databaseId: databaseOf(own, "events"), properties: { name: "Retro" } });
      const project = await cp.createItem({ databaseId: databaseOf(own, "projects"), properties: { name: "Project" } });
      // The derived edge as its owning process writes it (the event-link sync), through the system choke point.
      await withTransaction(runtime, (client) =>
        createRelationWithClient(
          client,
          { relationPropertyId: eventsProperty.id, callerItemId: day.itemId, targetItemId: linked.id },
          { ownerProcess: ownerProcessOf(eventsProperty) },
        ),
      );
      return { day: day.itemId, standup, linked, project };
    });
    const edges = (key: string) =>
      runInTenant(own.id, async () => {
        const relationProperty = await property(own, "journal", key);
        return (await createChokePoint(runtime).listItemRelations(fixture.day, relationProperty.id)) ?? [];
      });
    const eventsBefore = await edges("events");
    expect(eventsBefore.map((edge) => edge.targetItemId)).toEqual([fixture.linked.id]);
    invalidations = [];

    for (const [method, target] of [
      ["PUT", fixture.standup.id],
      ["DELETE", fixture.linked.id],
    ] as const) {
      const refused = await call(method, `/api/items/${fixture.day}/relations/events/${target}`, own.headers);
      expect(refused.status).toBe(403);
      expect(errorBody.parse(refused.json).error.code).toBe("owner_violation");
    }
    expect(await edges("events")).toEqual(eventsBefore);
    expect(invalidations).toEqual([]);

    // The same session may write the user-owned Journal `project` relation, so the refusal above is ownership, not a
    // missing grant.
    const put = await call("PUT", `/api/items/${fixture.day}/relations/project/${fixture.project.id}`, own.headers);
    expect(put.status).toBe(200);
    expect((await edges("project")).map((edge) => edge.targetItemId)).toEqual([fixture.project.id]);
    const removed = await call(
      "DELETE",
      `/api/items/${fixture.day}/relations/project/${fixture.project.id}`,
      own.headers,
    );
    expect(removed.status).toBe(200);
    expect(await edges("project")).toEqual([]);

    const foreignPut = await call(
      "PUT",
      `/api/items/${fixture.day}/relations/events/${fixture.standup.id}`,
      foreign.headers,
    );
    const randomPut = await call(
      "PUT",
      `/api/items/${randomUUID()}/relations/events/${fixture.standup.id}`,
      foreign.headers,
    );
    expect(foreignPut.status).toBe(404);
    expect(randomPut.status).toBe(404);
    expect(errorBody.parse(foreignPut.json).error.code).toBe(errorBody.parse(randomPut.json).error.code);
    expect(await edges("events")).toEqual(eventsBefore);
  });

  it("gh-1622: property create and patch accept number presets with other config and refuse every named negative", async () => {
    const own = await tenantWithUser();
    const foreign = await tenantWithUser();
    const database = await runInTenant(own.id, () => createChokePoint(runtime).createDatabase({ name: "Recipes" }));
    const valid = {
      default: 10,
      filterPresets: [{ value: 15, op: "lte", labelKey: "property.recipes.prep.preset.15", label: "Up to 15 min" }],
      emptyPreset: { labelKey: "property.recipes.prep.preset.none", matchZero: false },
    };
    const created = await call("POST", `/api/databases/${database.id}/properties`, own.headers, {
      key: "prep",
      name: "Prep",
      type: "number",
      config: valid,
    });
    expect(created.status).toBe(201);
    const prep = propertyEnvelope.parse(created.json);
    expect(prep.config).toEqual(valid);
    const patched = { default: 20, filterPresets: [...valid.filterPresets, { value: 30, op: "lte", labelKey: "k" }] };
    const patchedResponse = await call("PATCH", `/api/properties/${prep.id}`, own.headers, { config: patched });
    expect(patchedResponse.status).toBe(200);
    expect(propertyEnvelope.parse(patchedResponse.json).config).toEqual(patched);
    const notesResponse = await call("POST", `/api/databases/${database.id}/properties`, own.headers, {
      key: "notes",
      name: "Notes",
      type: "text",
      config: {},
    });
    expect(notesResponse.status).toBe(201);
    const notes = propertyEnvelope.parse(notesResponse.json);

    const preset = { value: 5, op: "gte", labelKey: "k" };
    const negatives: Array<[string, "number" | "text", Record<string, unknown>]> = [
      ["op eq", "number", { filterPresets: [{ ...preset, op: "eq" }] }],
      ["a non-numeric value", "number", { filterPresets: [{ ...preset, value: "5" }] }],
      ["an empty array", "number", { filterPresets: [] }],
      ["an unknown key", "number", { filterPresets: [{ ...preset, color: "#FF0000" }] }],
      ["emptyPreset without filterPresets", "number", { emptyPreset: { labelKey: "k", matchZero: true } }],
      ["presets on a text property", "text", { filterPresets: [preset] }],
    ];
    const propertyKeys = async () =>
      runInTenant(own.id, async () => (await createChokePoint(runtime).listProperties(database.id)).map((p) => p.key));
    const keysBefore = await propertyKeys();
    invalidations = [];
    for (const [name, type, config] of negatives) {
      const refused = await call("POST", `/api/databases/${database.id}/properties`, own.headers, {
        key: `negative${negatives.findIndex((entry) => entry[0] === name)}`,
        name,
        type,
        config,
      });
      expect(refused.status, name).toBe(400);
      expect(errorBody.parse(refused.json).error, name).toMatchObject({
        code: "validation_failed",
        details: { field: "config" },
      });
      const target = type === "number" ? prep : notes;
      const refusedPatch = await call("PATCH", `/api/properties/${target.id}`, own.headers, { config });
      expect(refusedPatch.status, name).toBe(400);
      expect(errorBody.parse(refusedPatch.json).error, name).toMatchObject({
        code: "validation_failed",
        details: { field: "config" },
      });
    }

    const foreignPatch = await call("PATCH", `/api/properties/${prep.id}`, foreign.headers, { config: valid });
    const randomPatch = await call("PATCH", `/api/properties/${randomUUID()}`, foreign.headers, { config: valid });
    expect(foreignPatch.status).toBe(404);
    expect(randomPatch.status).toBe(404);
    expect(errorBody.parse(foreignPatch.json).error.code).toBe(errorBody.parse(randomPatch.json).error.code);

    expect(await propertyKeys()).toEqual(keysBefore);
    expect(invalidations).toEqual([]);
    const stored = await runInTenant(own.id, async () => {
      const cp = createChokePoint(runtime);
      return { prep: await cp.getProperty(prep.id), notes: await cp.getProperty(notes.id) };
    });
    expect(stored.prep?.config).toEqual(patched);
    expect(stored.notes?.config).toEqual({});
  });

  it("gh-1622: retyping a number property with presets is refused without a replacement config and accepted with one", async () => {
    const own = await tenantWithUser();
    const database = await runInTenant(own.id, () => createChokePoint(runtime).createDatabase({ name: "Recipes" }));
    const presets = { filterPresets: [{ value: 15, op: "lte", labelKey: "k" }], default: 10 };
    const created = await call("POST", `/api/databases/${database.id}/properties`, own.headers, {
      key: "prep",
      name: "Prep",
      type: "number",
      config: presets,
    });
    expect(created.status).toBe(201);
    const prep = propertyEnvelope.parse(created.json);
    const stored = () => runInTenant(own.id, () => createChokePoint(runtime).getProperty(prep.id));
    const before = await stored();
    invalidations = [];

    const refused = await call("PATCH", `/api/properties/${prep.id}`, own.headers, { type: "text" });
    expect(refused.status).toBe(400);
    expect(errorBody.parse(refused.json).error).toMatchObject({
      code: "validation_failed",
      details: { field: "config" },
    });
    expect(await stored()).toEqual(before);
    expect(invalidations).toEqual([]);

    const retyped = await call("PATCH", `/api/properties/${prep.id}`, own.headers, { type: "text", config: {} });
    expect(retyped.status).toBe(200);
    expect(z.object({ type: z.string(), config: z.record(z.string(), z.unknown()) }).parse(retyped.json)).toEqual({
      type: "text",
      config: {},
    });
    expect(await stored()).toMatchObject({ type: "text", config: {} });
  });
});
