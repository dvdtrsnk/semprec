import type { CollectionMetadataResolver } from "@semprec/data";
import {
  createBlob,
  createItemWithClient,
  getDatabaseByModuleId,
  getSystemTimezone,
  today,
  insertInboxAttachments,
  listInboxAttachments,
} from "@semprec/data";
import { z } from "zod";
import * as Y from "yjs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  createRuntimeRolePool,
  getTestPool,
  getTenantZeroId,
  registerItemCreateHook,
  registerItemUpdateHook,
  resetDatabase,
  runMailboxAddressesOwnerCutoverMigration,
  tenantForNextTestUser,
  upsertMailMessageMeta,
} from "@semprec/data/testSupport";
import {
  createChokePoint,
  createSemprecTickAction,
  createDocStore,
  createUser,
  createViewTypeRegistry,
  ensureJournalPeriodDoc,
  hashPassword,
  insertValueLink,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  mutateYDoc,
  seedSystem,
  setInvalidationHook,
  type InvalidationEvent,
  updateItemWithClient,
  withTransaction,
  type AuthenticatedIdentity,
  type ChokePoint,
  type PasswordResetMailer,
  type WriterIdentity,
} from "@semprec/data";
import { runInTenant } from "@semprec/shared";
import { createGenericApplicationService } from "@semprec/application";
import { createDispatcher } from "../app.js";
import { createItemRoutes } from "../itemsHandler.js";

const testMetadataResolver: CollectionMetadataResolver = {
  resolve: () => ({
    icon: null,
    color: null,
    overviewOrder: null,
    switcherOrder: null,
    clientVisible: true,
    overviewHidden: false,
  }),
  collectionFilter: () => undefined,
  overviewHideable: () => false,
};

const PASSWORD = "s3cret-password";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);

const noopMailer: PasswordResetMailer = {
  async sendPasswordResetEmail() {},
};

let pool: Pool;
let chokePoint: ChokePoint;
const moduleRegistry = await loadFullModuleRegistry();

async function authHeader(): Promise<{ Authorization: string }> {
  const user = await createUser(pool, {
    tenantId: await tenantForNextTestUser(pool),
    email: `${randomUUID()}@example.com`,
    passwordHash: await hashPassword(PASSWORD),
  });
  const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  return { Authorization: `Bearer ${token}` };
}

interface ItemBody {
  id: string;
  databaseId: string;
  properties: Record<string, unknown>;
  computed: Record<string, unknown>;
  updatedAt: string;
  deletedAt: string | null;
  path?: ItemBody[];
  links?: Record<string, unknown>;
}

interface ErrorBody {
  error: { code: string; details?: unknown };
}

interface ItemQueryBody {
  items: ItemBody[];
  nextCursor: string | null;
  totalCount?: number;
}

interface RelationBody {
  id: string;
  relationDefinitionId: string;
  itemA: string;
  itemB: string;
  metadata: Record<string, unknown>;
}

/** The `links` of an item read with `include=links`. */
const linkedItemBody = z.object({ links: z.record(z.string(), z.unknown()) });
/** One link entry whose sources are all items, as the `fileCompaniesFromProjects` rule leaves it. */
const itemLinkEntry = z
  .object({
    valueKind: z.string(),
    sources: z.array(
      z
        .object({
          kind: z.literal("item"),
          itemId: z.string(),
          databaseKey: z.string(),
          title: z.string(),
          propertyKey: z.string(),
        })
        .strict(),
    ),
    brokenBy: z.string().nullable(),
    brokenAt: z.string().nullable(),
  })
  .strict();
/** An error body as REST sends it: its code and details. */
const httpError = z.object({ error: z.object({ code: z.string(), details: z.record(z.string(), z.unknown()) }) });
/** The properties of an item body. */
const itemProperties = z.object({ properties: z.record(z.string(), z.unknown()) });
/** The targets of an item's relations, from the relation list route. */
const relationTargets = z.object({
  relations: z.array(z.object({ propertyKey: z.string(), targetItemId: z.string() })),
});

describe("item routes (issue #241)", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);

    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "http://localhost",
      setupToken: "unused-setup-token",
      moduleRegistry,
      blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
      maxFileSizeBytes: 10 * 1024 * 1024,
    });
    server = createServer(dispatch);
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

  it("enforces derived relation admission through runtime HTTP", async () => {
    await seedSystem(pool, createViewTypeRegistry());
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const foreignHeaders = { ...(await authHeader()), "Content-Type": "application/json" };
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let runtimeServer: Server | undefined;
    const failures: unknown[] = [];
    try {
      const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const dispatch = await createDispatcher(runtime, {
        passwordResetMailer: noopMailer,
        appBaseUrl: "http://localhost",
        setupToken: "unused-setup-token",
        moduleRegistry,
        blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
        maxFileSizeBytes: 10 * 1024 * 1024,
      });
      runtimeServer = createServer(dispatch);
      const ownedServer = runtimeServer;
      await new Promise<void>((resolve, reject) => {
        ownedServer.once("error", reject);
        ownedServer.listen(0, "127.0.0.1", resolve);
      });
      const address = runtimeServer.address();
      if (!address || typeof address === "string") throw new Error("Expected runtime server");
      const base = `http://127.0.0.1:${address.port}`;
      const fixture = await runInTenant(getTenantZeroId(), async () => {
        const cp = createChokePoint(runtime);
        const databases = await cp.listDatabases();
        const db = (key: string) => {
          const match = databases.find((entry) => entry.ownerModuleId === key);
          if (!match) throw new Error(`Missing ${key}`);
          return match.id;
        };
        const event = await cp.createItem({
          databaseId: db("events"),
          properties: { name: "Event", date: "2026-10-16" },
        });
        const open = await cp.createItem({
          databaseId: db("events"),
          properties: { name: "Open", date: "2026-10-16" },
        });
        const file = await cp.createItem({ databaseId: db("files"), properties: { name: "File" } });
        const openFile = await cp.createItem({ databaseId: db("files"), properties: { name: "Open file" } });
        const health = await cp.createItem({ databaseId: db("healthRecords"), properties: { name: "Health" } });
        const openHealth = await cp.createItem({
          databaseId: db("healthRecords"),
          properties: { name: "Open health" },
        });
        const day = await withTransaction(runtime, (client) => ensureJournalPeriodDoc(client, "day", "2026-05-01"));
        const openDay = await withTransaction(runtime, (client) => ensureJournalPeriodDoc(client, "day", "2026-05-02"));
        const project = await cp.createItem({ databaseId: db("projects"), properties: { name: "Project" } });
        const company = await cp.createItem({ databaseId: db("companies"), properties: { name: "Company" } });
        const first = await cp.createItem({ databaseId: db("areas"), properties: { name: "First" } });
        const second = await cp.createItem({ databaseId: db("areas"), properties: { name: "Second" } });
        const area = (await cp.listProperties(db("events"))).find((p) => p.key === "area");
        const projectProperty = (await cp.listProperties(db("events"))).find((p) => p.key === "project");
        const fileProjects = (await cp.listProperties(db("files"))).find((p) => p.key === "projects");
        const healthProjects = (await cp.listProperties(db("healthRecords"))).find((p) => p.key === "projects");
        const journalProject = (await cp.listProperties(db("journal"))).find((p) => p.key === "project");
        if (!area || !projectProperty || !fileProjects || !healthProjects || !journalProject)
          throw new Error("Missing guarded relations");
        await cp.setRelation({ relationPropertyId: area.id, callerItemId: event.id, targetItemId: first.id });
        await cp.createRelation({
          relationPropertyId: projectProperty.id,
          callerItemId: event.id,
          targetItemId: project.id,
        });
        await cp.createRelation({
          relationPropertyId: fileProjects.id,
          callerItemId: file.id,
          targetItemId: project.id,
        });
        await cp.createRelation({
          relationPropertyId: healthProjects.id,
          callerItemId: health.id,
          targetItemId: project.id,
        });
        await cp.createRelation({
          relationPropertyId: journalProject.id,
          callerItemId: day.itemId,
          targetItemId: project.id,
        });
        return { event, open, file, openFile, health, openHealth, day, openDay, company, first, second };
      });
      const put = (source: string, target: string, requestHeaders = headers) =>
        fetch(`${base}/api/items/${source}/relations/area/${target}`, { method: "PUT", headers: requestHeaders });
      expect((await put(fixture.open.id, fixture.second.id)).status).toBe(200);
      expect((await put(fixture.openFile.id, fixture.second.id)).status).toBe(200);
      const deniedFile = await put(fixture.file.id, fixture.second.id);
      expect(deniedFile.status).toBe(400);
      expect(await deniedFile.json()).toMatchObject({ error: { details: { field: "area" } } });
      expect((await put(fixture.openHealth.id, fixture.second.id)).status).toBe(200);
      const deniedHealth = await put(fixture.health.id, fixture.second.id);
      expect(deniedHealth.status).toBe(400);
      expect(await deniedHealth.json()).toMatchObject({ error: { details: { field: "area" } } });
      expect((await put(fixture.openDay.itemId, fixture.second.id)).status).toBe(200);
      const deniedDay = await put(fixture.day.itemId, fixture.second.id);
      expect(deniedDay.status).toBe(400);
      expect(await deniedDay.json()).toMatchObject({ error: { details: { field: "area" } } });
      const putCompany = (source: string, key: string, target: string) =>
        fetch(`${base}/api/items/${source}/relations/${key}/${target}`, { method: "PUT", headers });
      expect((await putCompany(fixture.open.id, "company", fixture.company.id)).status).toBe(200);
      const deniedCompany = await putCompany(fixture.event.id, "company", fixture.company.id);
      expect(deniedCompany.status).toBe(400);
      expect(await deniedCompany.json()).toMatchObject({ error: { details: { field: "company" } } });
      const deniedInverse = await putCompany(fixture.company.id, "meetings", fixture.event.id);
      expect(deniedInverse.status).toBe(400);
      expect(await deniedInverse.json()).toMatchObject({ error: { details: { field: "company" } } });
      const denied = await put(fixture.event.id, fixture.second.id);
      expect(denied.status).toBe(400);
      expect(await denied.json()).toMatchObject({ error: { details: { field: "area" } } });
      const set = await fetch(`${base}/api/items/${fixture.event.id}/relations/area`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ targetItemId: fixture.second.id }),
      });
      expect(set.status).toBe(400);
      expect(await set.json()).toMatchObject({ error: { details: { field: "area" } } });
      const foreign = await put(fixture.event.id, fixture.second.id, foreignHeaders);
      const randomId = randomUUID();
      const random = await put(randomId, fixture.second.id, foreignHeaders);
      expect(foreign.status).toBe(404);
      expect(random.status).toBe(404);
      expect((await foreign.text()).replaceAll(fixture.event.id, "<id>")).toEqual(
        (await random.text()).replaceAll(randomId, "<id>"),
      );
      const edges = await runInTenant(getTenantZeroId(), () =>
        createChokePoint(runtime).listItemRelations(fixture.event.id),
      );
      expect(edges?.some((edge) => edge.targetItemId === fixture.first.id)).toBe(true);
      expect(edges?.some((edge) => edge.targetItemId === fixture.second.id)).toBe(false);
      const fileEdges = await runInTenant(getTenantZeroId(), () =>
        createChokePoint(runtime).listItemRelations(fixture.file.id),
      );
      expect(fileEdges?.some((edge) => edge.targetItemId === fixture.second.id)).toBe(false);
      const healthEdges = await runInTenant(getTenantZeroId(), () =>
        createChokePoint(runtime).listItemRelations(fixture.health.id),
      );
      expect(healthEdges?.some((edge) => edge.targetItemId === fixture.second.id)).toBe(false);
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        if (runtimeServer)
          await new Promise<void>((resolve, reject) =>
            runtimeServer?.close((error) => (error ? reject(error) : resolve())),
          );
      } catch (error) {
        failures.push(error);
      }
      try {
        await runtime.end();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "REST test and settlement failed");
  });

  it("enforces Tasks completion and both protected relation pairs through authenticated runtime HTTP", async () => {
    await seedSystem(pool, createViewTypeRegistry());
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let runtimeServer: Server | undefined;
    const failures: unknown[] = [];
    try {
      const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const dispatch = await createDispatcher(runtime, {
        passwordResetMailer: noopMailer,
        appBaseUrl: "http://localhost",
        setupToken: "unused-setup-token",
        moduleRegistry,
        blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
        maxFileSizeBytes: 10 * 1024 * 1024,
      });
      runtimeServer = createServer(dispatch);
      await new Promise<void>((resolve) => runtimeServer?.listen(0, "127.0.0.1", resolve));
      const address = runtimeServer.address();
      if (!address || typeof address === "string") throw new Error("Expected runtime server");
      const base = `http://127.0.0.1:${address.port}`;
      const fixture = await runInTenant(getTenantZeroId(), async () => {
        const cp = createChokePoint(runtime);
        const ids = await withTransaction(runtime, async (client) => {
          const taskDb = await getDatabaseByModuleId(client, "tasks");
          const eventDb = await getDatabaseByModuleId(client, "events");
          const peopleDb = await getDatabaseByModuleId(client, "people");
          if (!taskDb || !eventDb || !peopleDb) throw new Error("Missing system database");
          return { tasks: taskDb.id, events: eventDb.id, people: peopleDb.id };
        });
        const task = await cp.createItem({ databaseId: ids.tasks, properties: { name: "Task", date: "2099-10-22" } });
        const event = await cp.createItem({
          databaseId: ids.events,
          properties: { name: "Event", date: "2026-10-16" },
        });
        const inverseTask = await cp.createItem({ databaseId: ids.tasks, properties: { name: "Inverse Task" } });
        const inverseEvent = await cp.createItem({
          databaseId: ids.events,
          properties: { name: "Inverse Event", date: "2026-10-16" },
        });
        const person = await cp.createItem({ databaseId: ids.people, properties: { name: "Person" } });
        return { task, event, inverseTask, inverseEvent, person };
      });
      const beforeEdges = await runInTenant(getTenantZeroId(), () =>
        runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM item_relations"),
      );
      const foreignRelationHeaders = await authHeader();
      for (const [source, key, target] of [
        [fixture.task.id, "hostEvents", fixture.event.id],
        [fixture.event.id, "hostedTasks", fixture.task.id],
        [fixture.task.id, "completedInEvent", fixture.event.id],
        [fixture.event.id, "completedTasks", fixture.task.id],
      ] as const) {
        for (const method of ["PUT", "DELETE"] as const) {
          const response = await fetch(`${base}/api/items/${source}/relations/${key}/${target}`, { method, headers });
          expect(response.status).toBe(403);
          expect(await response.json()).toMatchObject({ error: { code: "owner_violation" } });
          const randomSource = randomUUID();
          const foreign = await fetch(`${base}/api/items/${source}/relations/${key}/${target}`, {
            method,
            headers: foreignRelationHeaders,
          });
          const random = await fetch(`${base}/api/items/${randomSource}/relations/${key}/${target}`, {
            method,
            headers: foreignRelationHeaders,
          });
          expect(foreign.status).toBe(404);
          expect(random.status).toBe(404);
          expect((await foreign.text()).replaceAll(source, "<id>")).toEqual(
            (await random.text()).replaceAll(randomSource, "<id>"),
          );
        }
      }
      expect(
        (
          await runInTenant(getTenantZeroId(), () =>
            runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM item_relations"),
          )
        ).rows,
      ).toEqual(beforeEdges.rows);
      for (const [source, key, target] of [
        [fixture.event.id, "actionItems", fixture.task.id],
        [fixture.inverseTask.id, "sourceEvents", fixture.inverseEvent.id],
      ] as const) {
        const randomSource = randomUUID();
        const foreign = await fetch(`${base}/api/items/${source}/relations/${key}/${target}`, {
          method: "PUT",
          headers: foreignRelationHeaders,
        });
        const random = await fetch(`${base}/api/items/${randomSource}/relations/${key}/${target}`, {
          method: "PUT",
          headers: foreignRelationHeaders,
        });
        expect(foreign.status).toBe(404);
        expect(random.status).toBe(404);
        expect((await foreign.text()).replaceAll(source, "<id>")).toEqual(
          (await random.text()).replaceAll(randomSource, "<id>"),
        );
      }
      expect(
        (
          await runInTenant(getTenantZeroId(), () =>
            runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM item_relations"),
          )
        ).rows,
      ).toEqual(beforeEdges.rows);
      for (const [source, key, target, inverseKey] of [
        [fixture.event.id, "actionItems", fixture.task.id, "sourceEvents"],
        [fixture.inverseTask.id, "sourceEvents", fixture.inverseEvent.id, "actionItems"],
      ] as const) {
        expect(
          (await fetch(`${base}/api/items/${source}/relations/${key}/${target}`, { method: "PUT", headers })).status,
        ).toBe(200);
        for (const [id, propertyKey, targetItemId] of [
          [source, key, target],
          [target, inverseKey, source],
        ] as const) {
          const response = await fetch(`${base}/api/items/${id}/relations?propertyKey=${propertyKey}`, { headers });
          expect(response.status).toBe(200);
          const body = z
            .object({ relations: z.array(z.object({ propertyKey: z.string(), targetItemId: z.string() })) })
            .parse(await response.json());
          expect(body.relations).toEqual([{ propertyKey, targetItemId }]);
        }
      }
      expect(
        (
          await fetch(`${base}/api/items/${fixture.task.id}/relations/people/${fixture.person.id}`, {
            method: "PUT",
            headers,
          })
        ).status,
      ).toBe(200);
      const itemUrl = `${base}/api/items/${fixture.task.id}`;
      const itemSchema = z.object({ updatedAt: z.string(), properties: z.record(z.string(), z.unknown()) });
      const before = itemSchema.parse(await (await fetch(itemUrl, { headers })).json());
      const foreignHeaders = { ...(await authHeader()), "Content-Type": "application/json" };
      const foreign = await fetch(itemUrl, {
        method: "PATCH",
        headers: foreignHeaders,
        body: JSON.stringify({ properties: { status: "done" }, ifVersion: before.updatedAt }),
      });
      const randomId = randomUUID();
      const random = await fetch(`${base}/api/items/${randomId}`, {
        method: "PATCH",
        headers: foreignHeaders,
        body: JSON.stringify({ properties: { status: "done" }, ifVersion: before.updatedAt }),
      });
      expect(foreign.status).toBe(404);
      expect(random.status).toBe(404);
      expect((await foreign.text()).replaceAll(fixture.task.id, "<id>")).toEqual(
        (await random.text()).replaceAll(randomId, "<id>"),
      );
      const refused = await fetch(itemUrl, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          properties: { status: "done", completedOn: "2999-01-01" },
          ifVersion: before.updatedAt,
        }),
      });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({
        error: { code: "validation_failed", details: { field: "completedOn" } },
      });
      expect(itemSchema.parse(await (await fetch(itemUrl, { headers })).json())).toEqual(before);
      const done = await fetch(itemUrl, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties: { status: "done" }, ifVersion: before.updatedAt }),
      });
      expect(done.status).toBe(200);
      const completed = itemSchema.parse(await done.json());
      expect(completed.properties).toMatchObject({
        status: "done",
        date: "2099-10-22",
        completedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        completedAt: expect.any(String),
      });
      const rollover = await runInTenant(getTenantZeroId(), async () => {
        const cp = createChokePoint(runtime);
        const task = await cp.createItem({
          databaseId: fixture.task.databaseId,
          properties: { name: "Moved", date: "2000-01-01", timeFrom: "10:00", timeTo: "11:00" },
        });
        const view = await cp.createView({
          databaseId: fixture.task.databaseId,
          type: "table",
          name: "Tasks",
          config: {},
        });
        return { task, view };
      });
      const movedResponse = await fetch(`${base}/api/items/${rollover.task.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties: { date: "2000-01-02" }, ifVersion: rollover.task.updatedAt }),
      });
      expect(movedResponse.status).toBe(200);
      const moved = itemSchema.parse(await movedResponse.json());
      const expected = { since: "2000-01-01", sinceTime: { from: "10:00", to: "11:00" } };
      expect(moved.properties).toMatchObject(expected);
      expect(
        itemSchema.parse(await (await fetch(`${base}/api/items/${rollover.task.id}`, { headers })).json()).properties,
      ).toMatchObject(expected);
      const missingItem = randomUUID();
      const foreignGet = await fetch(`${base}/api/items/${rollover.task.id}`, { headers: foreignHeaders });
      const randomGet = await fetch(`${base}/api/items/${missingItem}`, { headers: foreignHeaders });
      expect(foreignGet.status).toBe(404);
      expect(randomGet.status).toBe(404);
      expect((await foreignGet.text()).replaceAll(rollover.task.id, "<id>")).toEqual(
        (await randomGet.text()).replaceAll(missingItem, "<id>"),
      );
      const viewResponse = await fetch(`${base}/api/views/${rollover.view.id}/query`, {
        method: "POST",
        headers,
        body: "{}",
      });
      expect(viewResponse.status).toBe(200);
      const viewBody = z
        .object({ items: z.array(z.object({ id: z.string(), properties: z.record(z.string(), z.unknown()) })) })
        .parse(await viewResponse.json());
      expect(viewBody.items.find((item) => item.id === rollover.task.id)?.properties).toMatchObject(expected);
      const missingView = randomUUID();
      const foreignView = await fetch(`${base}/api/views/${rollover.view.id}/query`, {
        method: "POST",
        headers: foreignHeaders,
        body: "{}",
      });
      const randomView = await fetch(`${base}/api/views/${missingView}/query`, {
        method: "POST",
        headers: foreignHeaders,
        body: "{}",
      });
      expect(foreignView.status).toBe(404);
      expect(randomView.status).toBe(404);
      expect((await foreignView.text()).replaceAll(rollover.view.id, "<id>")).toEqual(
        (await randomView.text()).replaceAll(missingView, "<id>"),
      );
      for (const properties of [
        { since: "1999-01-01" },
        { sinceTime: { from: "08:00", to: null } },
        { completedAt: "2020-01-01T00:00:00Z" },
      ]) {
        const response = await fetch(`${base}/api/items/${rollover.task.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ properties, ifVersion: moved.updatedAt }),
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: { code: "owner_violation" } });
      }
      expect(
        itemSchema.parse(await (await fetch(`${base}/api/items/${rollover.task.id}`, { headers })).json()),
      ).toEqual(moved);
    } catch (error) {
      failures.push(error);
    }
    if (runtimeServer)
      try {
        await new Promise<void>((resolve, reject) =>
          runtimeServer?.close((error) => (error ? reject(error) : resolve())),
        );
      } catch (error) {
        failures.push(error);
      }
    try {
      await runtime.end();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "REST test and settlement failed");
  });

  it("validates Areas icon and color through authenticated PATCH", async () => {
    await seedSystem(pool, createViewTypeRegistry());
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const fixture = await runInTenant(getTenantZeroId(), async () => {
      const database = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "areas"));
      if (!database) throw new Error("Missing Areas database");
      const item = await chokePoint.createItem({ databaseId: database.id, properties: { name: "Area" } });
      return { database, item };
    });
    const patch = async (properties: Record<string, unknown>) => {
      const current = await runInTenant(getTenantZeroId(), () =>
        chokePoint.getItem(fixture.database.id, fixture.item.id),
      );
      if (!current) throw new Error("Missing Areas item");
      return fetch(`${baseUrl}/api/items/${fixture.item.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties, ifVersion: current.updatedAt }),
      });
    };
    const valid = await patch({ icon: "briefcase", color: "#5856D6" });
    expect(valid.status).toBe(200);
    expect(
      (await runInTenant(getTenantZeroId(), () => chokePoint.getItem(fixture.database.id, fixture.item.id)))
        ?.properties,
    ).toMatchObject({ icon: "briefcase", color: "#5856D6" });
    for (const [field, value] of [
      ["icon", "rocket123"],
      ["color", "#123456"],
    ] as const) {
      const response = await patch({ [field]: value });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation_failed", details: { field } } });
    }
    expect((await patch({ icon: null, color: null })).status).toBe(200);
    expect(
      (await runInTenant(getTenantZeroId(), () => chokePoint.getItem(fixture.database.id, fixture.item.id)))
        ?.properties,
    ).toMatchObject({ icon: null, color: null });
  });

  it("writes and reads People phones through item routes", async () => {
    await seedSystem(pool, createViewTypeRegistry());
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const database = await runInTenant(getTenantZeroId(), () =>
      withTransaction(pool, (client) => getDatabaseByModuleId(client, "people")),
    );
    if (!database) throw new Error("People missing");
    const created = await fetch(`${baseUrl}/api/databases/${database.id}/items`, {
      method: "POST",
      headers,
      body: JSON.stringify({ properties: { name: "Person", phones: "777 123 456" } }),
    });
    expect(created.status).toBe(201);
    const item = z.object({ id: z.string() }).parse(await created.json());
    const response = await fetch(`${baseUrl}/api/items/${item.id}`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ properties: { phones: "777 123 456" } });
  });

  it("includes Journal day metadata in page breadcrumbs", async () => {
    await seedSystem(pool, createViewTypeRegistry());
    const headers = await authHeader();
    const day = await runInTenant(getTenantZeroId(), () =>
      withTransaction(pool, (client) => ensureJournalPeriodDoc(client, "day", "2026-10-16")),
    );
    const response = await fetch(`${baseUrl}/api/items/${day.itemId}/page`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      breadcrumbs: [expect.objectContaining({ itemId: day.itemId, journal: { type: "day", period: "2026-10-16" } })],
    });
  });

  it("uses each database's title property in inline page breadcrumbs", async () => {
    const headers = await authHeader();
    const fixture = await runInTenant(getTenantZeroId(), async () => {
      const parentDb = await chokePoint.createDatabase({ name: "Parent" });
      await chokePoint.createProperty({ databaseId: parentDb.id, key: "heading", name: "Heading", type: "title" });
      const parent = await chokePoint.createItem({ databaseId: parentDb.id, properties: { heading: "Parent title" } });
      const childDb = await chokePoint.createInlineDatabase({ name: "Child", parentItemId: parent.id });
      await chokePoint.createProperty({ databaseId: childDb.id, key: "caption", name: "Caption", type: "title" });
      const child = await chokePoint.createItem({ databaseId: childDb.id, properties: { caption: "Child title" } });
      return { parent, child };
    });
    const response = await fetch(`${baseUrl}/api/items/${fixture.child.id}/page`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      breadcrumbs: [
        { itemId: fixture.parent.id, title: "Parent title" },
        { itemId: fixture.child.id, title: "Child title" },
      ],
    });
  });

  it("ensures one page across concurrent HTTP calls and refuses trashed or wrong-kind items", async () => {
    const headers = await authHeader();
    const fixture = await runInTenant(getTenantZeroId(), async () => {
      const database = await chokePoint.createDatabase({ name: "Ensure pages" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
      const canvas = await chokePoint.createItem({ databaseId: database.id, properties: {} });
      await createDocStore(pool).getOrCreateDoc(canvas.id, "canvas");
      return { database, item, canvas };
    });
    const path = `${baseUrl}/api/items/${fixture.item.id}/page`;
    const [first, second] = await Promise.all([
      fetch(path, { method: "PUT", headers }),
      fetch(path, { method: "PUT", headers }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = z.object({ docId: z.string() }).parse(await first.json());
    expect(await second.json()).toEqual(firstBody);
    const repeat = await fetch(path, { method: "PUT", headers });
    expect(await repeat.json()).toEqual(firstBody);
    const summary = await fetch(path, { headers });
    expect(await summary.json()).toMatchObject(firstBody);
    const stored = await pool.query<{ id: string }>("SELECT id FROM docs WHERE item_id = $1", [fixture.item.id]);
    expect(stored.rows).toEqual([{ id: firstBody.docId }]);
    const wrongKind = await fetch(`${baseUrl}/api/items/${fixture.canvas.id}/page`, { method: "PUT", headers });
    expect(wrongKind.status).toBe(409);
    const canvasRows = await pool.query<{ id: string; kind: string }>("SELECT id, kind FROM docs WHERE item_id = $1", [
      fixture.canvas.id,
    ]);
    expect(canvasRows.rows).toHaveLength(1);
    expect(canvasRows.rows[0]?.kind).toBe("canvas");
    await runInTenant(getTenantZeroId(), () => chokePoint.softDeleteItem(fixture.database.id, fixture.item.id));
    expect((await fetch(path, { method: "PUT", headers })).status).toBe(404);
    expect((await fetch(path, { method: "PUT" })).status).toBe(401);
  });

  it("refuses a canvas as a page over HTTP without changing its document", async () => {
    const headers = await authHeader();
    const item = await runInTenant(getTenantZeroId(), async () => {
      const database = await chokePoint.createDatabase({ name: "Canvas" });
      return chokePoint.createItem({ databaseId: database.id, properties: {} });
    });
    const store = createDocStore(pool);
    await runInTenant(getTenantZeroId(), () =>
      store.putCanvasElement(item.id, { id: "shape", type: "shape", xywh: [0, 0, 10, 10], index: "a0" }, "user"),
    );
    const state = () =>
      pool.query(
        `SELECT to_jsonb(d) AS doc, to_jsonb(s) AS snapshot,
          (SELECT jsonb_agg(to_jsonb(u) ORDER BY u.id) FROM doc_updates u WHERE u.doc_id = d.id) AS updates
         FROM docs d LEFT JOIN doc_snapshots s ON s.doc_id = d.id WHERE d.item_id = $1`,
        [item.id],
      );
    const before = await state();
    expect(before.rows).toHaveLength(1);
    const response = await fetch(`${baseUrl}/api/items/${item.id}/page`, { headers });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "version_conflict" } });
    expect((await state()).rows).toEqual(before.rows);
  });

  it("reads page summaries over HTTP without creating a document and counts beyond the limit", async () => {
    const headers = await authHeader();
    const fixture = await runInTenant(getTenantZeroId(), async () => {
      const database = await chokePoint.createDatabase({ name: "Pages" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
      return { database, item };
    });
    const path = `${baseUrl}/api/items/${fixture.item.id}/page`;
    const empty = await fetch(path, { headers });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ docId: null, blockCount: 0, subpageCount: 0, breadcrumbs: null });
    expect((await pool.query("SELECT id FROM docs WHERE item_id = $1", [fixture.item.id])).rows).toHaveLength(0);
    const store = createDocStore(pool);
    const row = await runInTenant(getTenantZeroId(), () => store.getOrCreateDoc(fixture.item.id, "page"));
    await runInTenant(getTenantZeroId(), () =>
      mutateYDoc(pool, row.id, "user", (doc) => {
        const blocks = doc.getMap<Y.Map<unknown>>("blocks");
        const order = doc.getArray<string>("order");
        for (let i = 0; i < 14; i++) {
          const id = `block-${i}`;
          const block = new Y.Map<unknown>();
          block.set("sys:id", id);
          block.set("sys:flavour", i < 2 ? "page" : "text");
          if (i < 2) block.set("pageId", `page-${i}`);
          else {
            const text = new Y.Text();
            text.insert(0, `Text ${i}`);
            block.set("text", text);
          }
          blocks.set(id, block);
          order.push([id]);
        }
      }),
    );
    const limited = await fetch(`${path}?limit=5`, { headers });
    expect(limited.status).toBe(200);
    expect(await limited.json()).toMatchObject({
      docId: row.id,
      blockCount: 14,
      subpageCount: 2,
      blocks: [{ pageId: "page-0" }, { pageId: "page-1" }, {}, {}, {}],
    });
    const markdown = await fetch(`${path}?format=markdown`, { headers });
    expect(markdown.status).toBe(200);
    expect(await markdown.json()).toMatchObject({ docId: row.id, kind: "page", markdown: expect.any(String) });
    const unknownFormat = await fetch(`${path}?format=html`, { headers });
    expect(unknownFormat.status).toBe(400);
    expect(await unknownFormat.json()).toMatchObject({ error: { details: { field: "format" } } });
    expect((await fetch(path)).status).toBe(401);
  });

  it("refuses deletion of the unplanned system area through REST", async () => {
    await seedSystem(pool, createViewTypeRegistry());
    const headers = await authHeader();
    const fixture = await runInTenant(getTenantZeroId(), async () => {
      const database = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "areas"));
      if (!database) throw new Error("Areas missing");
      const list = await chokePoint.listItems(database.id);
      const item = list.items.find((row) => row.properties.systemActive === true);
      if (!item) throw new Error("System area missing");
      return { database, item };
    });
    const response = await fetch(`${baseUrl}/api/items/${fixture.item.id}`, { method: "DELETE", headers });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { details: { field: "systemActive" } } });
    expect(
      await runInTenant(getTenantZeroId(), () => chokePoint.getItem(fixture.database.id, fixture.item.id)),
    ).toEqual(fixture.item);
  });

  it("returns project completion dates and refuses direct writes through REST", async () => {
    await seedSystem(pool, createViewTypeRegistry());
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const fixture = await runInTenant(getTenantZeroId(), async () => {
      const database = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects"));
      if (!database) throw new Error("Projects missing");
      const item = await chokePoint.createItem({
        databaseId: database.id,
        properties: { name: "Project", status: "inProgress" },
      });
      const day = today(await withTransaction(pool, getSystemTimezone));
      return { database, item, day };
    });
    const patch = async (properties: Record<string, unknown>) => {
      const current = await runInTenant(getTenantZeroId(), () =>
        chokePoint.getItem(fixture.database.id, fixture.item.id),
      );
      if (!current) throw new Error("Project missing");
      return fetch(`${baseUrl}/api/items/${current.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties, ifVersion: current.updatedAt }),
      });
    };
    const done = await patch({ status: "done" });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ properties: { status: "done", completedAt: fixture.day } });
    const refused = await patch({ completedAt: "2000-01-01" });
    expect(refused.status).toBe(403);
    expect(
      (await runInTenant(getTenantZeroId(), () => chokePoint.getItem(fixture.database.id, fixture.item.id)))?.properties
        .completedAt,
    ).toBe(fixture.day);
  });

  it("hides a kept project deadline in REST reads and the search index", async () => {
    await seedSystem(pool, createViewTypeRegistry());
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const fixture = await runInTenant(getTenantZeroId(), async () => {
      const database = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects"));
      if (!database) throw new Error("Projects missing");
      const item = await chokePoint.createItem({
        databaseId: database.id,
        properties: { name: "Distinctiveproject", status: "inProgress", date: "2042-11-30" },
      });
      return { database, item };
    });
    const patch = async (properties: Record<string, unknown>) => {
      const item = await runInTenant(getTenantZeroId(), () => chokePoint.getItem(fixture.database.id, fixture.item.id));
      if (!item) throw new Error("Project missing");
      return fetch(`${baseUrl}/api/items/${item.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties, ifVersion: item.updatedAt }),
      });
    };
    const changed = await patch({ status: "longTerm" });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ properties: { status: "longTerm", date: null } });
    const rejected = await patch({ date: "2043-01-01" });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { code: "validation_failed", details: { field: "date" } } });
    const read = await fetch(`${baseUrl}/api/items/${fixture.item.id}`, { headers });
    expect(read.status).toBe(200);
    const body: unknown = await read.json();
    expect(body).toMatchObject({ properties: { date: null } });
    expect(JSON.stringify(body)).not.toContain("2042-11-30");
    const index = await runInTenant(getTenantZeroId(), () =>
      pool.query<{ name_match: boolean; date_match: boolean }>(
        `SELECT search_vector @@ websearch_to_tsquery('czech', 'Distinctiveproject') AS name_match,
       search_vector @@ websearch_to_tsquery('czech', '2042-11-30') AS date_match
       FROM item_search_index WHERE item_id=$1`,
        [fixture.item.id],
      ),
    );
    expect(index.rows).toEqual([{ name_match: true, date_match: false }]);
    const restored = await patch({ status: "inProgress" });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ properties: { date: "2042-11-30" } });
  });

  it("validates color writes over authenticated REST and preserves legacy colors on unrelated updates", async () => {
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const fixture = await runInTenant(getTenantZeroId(), async () => {
      const database = await chokePoint.createDatabase({ name: "Colors" });
      await chokePoint.createProperty({ databaseId: database.id, key: "color", name: "Color", type: "color" });
      await chokePoint.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "text" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: { color: "#FF3B30" } });
      return { database, item };
    });
    const patch = (properties: Record<string, unknown>, ifVersion: string) =>
      fetch(`${baseUrl}/api/items/${fixture.item.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties, ifVersion }),
      });
    for (const color of ["red", "Červená"]) {
      const response = await patch({ color }, fixture.item.updatedAt);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "validation_failed", details: { field: "color" } },
      });
      expect(
        (await runInTenant(getTenantZeroId(), () => chokePoint.getItem(fixture.database.id, fixture.item.id)))
          ?.properties.color,
      ).toBe("#FF3B30");
    }
    const valid = await patch({ color: "#ff3b30" }, fixture.item.updatedAt);
    expect(valid.status).toBe(200);
    const changed = await runInTenant(getTenantZeroId(), () =>
      chokePoint.getItem(fixture.database.id, fixture.item.id),
    );
    if (!changed) throw new Error("Missing item");
    expect(changed.properties.color).toBe("#ff3b30");
    const clear = await patch({ color: null }, changed.updatedAt);
    expect(clear.status).toBe(200);
    // Legacy values predate validation and cannot be written through the current API.
    await pool.query("UPDATE items SET properties = jsonb_set(properties, '{color}', $1::jsonb) WHERE id = $2", [
      JSON.stringify("red"),
      fixture.item.id,
    ]);
    const legacy = await runInTenant(getTenantZeroId(), () => chokePoint.getItem(fixture.database.id, fixture.item.id));
    if (!legacy) throw new Error("Missing legacy item");
    const unrelated = await patch({ name: "Renamed" }, legacy.updatedAt);
    expect(unrelated.status).toBe(200);
    expect(
      (await runInTenant(getTenantZeroId(), () => chokePoint.getItem(fixture.database.id, fixture.item.id)))?.properties
        .color,
    ).toBe("red");
  });

  it("rejects an invalid proposal color atomically and confirms a valid color", async () => {
    await seedSystem(pool, createViewTypeRegistry());
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const fixture = await runInTenant(getTenantZeroId(), async () => {
      const idFor = async (module: string) => {
        const database = await withTransaction(pool, (client) => getDatabaseByModuleId(client, module));
        if (!database) throw new Error(`Missing ${module}`);
        return database.id;
      };
      const inboxDatabaseId = await idFor("inbox");
      const inboxItemTypesDatabaseId = await idFor("inboxItemTypes");
      const processingProposalsDatabaseId = await idFor("processingProposals");
      const projects = await idFor("projects");
      const type = await chokePoint.createItem({
        databaseId: inboxItemTypesDatabaseId,
        properties: { name: "Project", emoji: "P", processingMethod: "database", targetDatabase: "projects" },
      });
      const source = await chokePoint.createItem({
        databaseId: inboxDatabaseId,
        properties: { text: "Project", date: "2026-08-28", time: "09:00" },
      });
      const typeProperty = (await chokePoint.listProperties(inboxDatabaseId)).find(
        (property) => property.key === "type",
      );
      if (!typeProperty) throw new Error("Missing inbox type property");
      await chokePoint.createRelation({
        relationPropertyId: typeProperty.id,
        callerItemId: source.id,
        targetItemId: type.id,
      });
      const tick = createSemprecTickAction(pool, async () => ({ properties: { name: "New Project" } }));
      await tick(
        { inboxDatabaseId, inboxItemTypesDatabaseId, processingProposalsDatabaseId },
        { heartbeatId: "hb", projectItemId: "proj", itemId: source.id },
      );
      const cards = await chokePoint.listItems(processingProposalsDatabaseId);
      if (cards.items.length !== 1 || !cards.items[0]) throw new Error("Expected a proposal card");
      return { projects, processingProposalsDatabaseId, cardId: cards.items[0].id };
    });
    const storeProposal = (color: string) =>
      runInTenant(getTenantZeroId(), () =>
        withTransaction(pool, (client) =>
          updateItemWithClient(
            client,
            {
              databaseId: fixture.processingProposalsDatabaseId,
              itemId: fixture.cardId,
              propertiesPatch: {
                proposal: {
                  entityKind: "database",
                  target: fixture.projects,
                  properties: { name: "New Project", color },
                  operations: [
                    {
                      ref: "project",
                      op: "create",
                      role: "primary",
                      databaseKey: "projects",
                      properties: { name: "New Project", color },
                    },
                  ],
                },
              },
            },
            { allowedSystemKeys: ["proposal"] },
          ),
        ),
      );
    await storeProposal("red");
    const beforeCard = await runInTenant(getTenantZeroId(), () =>
      chokePoint.getItem(fixture.processingProposalsDatabaseId, fixture.cardId),
    );
    const before = await runInTenant(getTenantZeroId(), () => chokePoint.listItems(fixture.projects));
    const confirm = () =>
      fetch(`${baseUrl}/api/proposals/${fixture.cardId}/confirm`, { method: "POST", headers, body: "{}" });
    const rejected = await confirm();
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { code: "validation_failed", details: { field: "color" } } });
    expect(
      await runInTenant(getTenantZeroId(), () =>
        chokePoint.getItem(fixture.processingProposalsDatabaseId, fixture.cardId),
      ),
    ).toEqual(beforeCard);
    expect(await runInTenant(getTenantZeroId(), () => chokePoint.listItems(fixture.projects))).toEqual(before);
    await storeProposal("#FF3B30");
    const accepted = await confirm();
    expect(accepted.status).toBe(200);
    const projects = await runInTenant(getTenantZeroId(), () => chokePoint.listItems(fixture.projects));
    expect(
      projects.items.some((item) => item.properties.name === "New Project" && item.properties.color === "#FF3B30"),
    ).toBe(true);
  });

  it("validates Inbox capture and type writes through REST and replays a capture without duplicating its day edge", async () => {
    await seedSystem(pool, createViewTypeRegistry());
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const databases = await runInTenant(getTenantZeroId(), () =>
      withTransaction(pool, async (client) => {
        const inbox = await getDatabaseByModuleId(client, "inbox");
        const types = await getDatabaseByModuleId(client, "inboxItemTypes");
        if (!inbox || !types) throw new Error("Inbox databases were not seeded");
        return { inbox, types };
      }),
    );
    const create = (databaseId: string, properties: Record<string, unknown>, key = randomUUID()) =>
      fetch(`${baseUrl}/api/databases/${databaseId}/items`, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": key },
        body: JSON.stringify({ properties }),
      });
    const count = async (databaseId: string) =>
      (await runInTenant(getTenantZeroId(), () => chokePoint.listItems(databaseId))).items.length;
    for (const [databaseId, properties, field] of [
      [databases.inbox.id, { date: "2026-02-30", time: "12:00" }, "date"],
      [databases.inbox.id, { date: "2026-10-16", time: "24:00" }, "time"],
      [
        databases.types.id,
        { name: "Invalid", processingMethod: "database", targetDatabase: "journal" },
        "targetDatabase",
      ],
      [
        databases.types.id,
        { name: "Invalid", processingMethod: "database", targetDatabase: "transcripts" },
        "targetDatabase",
      ],
      [
        databases.types.id,
        { name: "Invalid", processingMethod: "database", targetDatabase: "nonsense" },
        "targetDatabase",
      ],
    ] as const) {
      const before = await count(databaseId);
      const response = await create(databaseId, properties);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation_failed", details: { field } } });
      expect(await count(databaseId)).toBe(before);
    }
    const key = randomUUID();
    const first = await create(databases.inbox.id, { date: "2026-10-16", time: "12:00" }, key);
    const replay = await create(databases.inbox.id, { date: "2026-10-16", time: "12:00" }, key);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    const itemSchema = z.object({ id: z.string() });
    const firstBody: unknown = await first.json();
    const replayBody: unknown = await replay.json();
    const itemId = itemSchema.parse(firstBody).id;
    expect(itemSchema.parse(replayBody).id).toBe(itemId);
    expect(await count(databases.inbox.id)).toBe(1);
    const days = await runInTenant(getTenantZeroId(), () =>
      withTransaction(pool, async (client) => {
        const { rows } = await client.query<{ period: string }>(
          `SELECT day.properties->>'period' AS period FROM item_relations r
         JOIN relation_definitions d ON d.id = r.relation_definition_id
         JOIN properties p ON p.id = d.property_id_a
         JOIN items day ON day.id = r.item_b
         WHERE p.database_id = $1 AND p.key = 'journalDay' AND r.item_a = $2`,
          [databases.inbox.id, itemId],
        );
        return rows;
      }),
    );
    expect(days).toEqual([{ period: "2026-10-16" }]);
    const valid = await create(databases.types.id, {
      name: "Valid",
      processingMethod: "database",
      targetDatabase: "tasks",
    });
    expect(valid.status).toBe(201);
    const validBody: unknown = await valid.json();
    const typeItem = z.object({ id: z.string(), updatedAt: z.string() }).parse(validBody);
    const patch = (properties: Record<string, unknown>, ifVersion: string) =>
      fetch(`${baseUrl}/api/items/${typeItem.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties, ifVersion }),
      });
    for (const properties of [
      { targetDatabase: "journal" },
      { targetDatabase: "transcripts" },
      { targetDatabase: "nonsense" },
      { processingMethod: "pageContent" },
    ]) {
      const rejected = await patch(properties, typeItem.updatedAt);
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({
        error: { code: "validation_failed", details: { field: "targetDatabase" } },
      });
      const unchanged = await runInTenant(getTenantZeroId(), () => chokePoint.getItem(databases.types.id, typeItem.id));
      expect(unchanged?.properties).toMatchObject({ processingMethod: "database", targetDatabase: "tasks" });
    }
    // Generic writes before validation could persist the now-disallowed journal target.
    await runInTenant(getTenantZeroId(), () =>
      withTransaction(pool, async (client) => {
        const result = await client.query<{ id: string }>(
          "UPDATE items SET properties = jsonb_set(properties, '{targetDatabase}', to_jsonb($3::text)) WHERE database_id = $1 AND id = $2 RETURNING id",
          [databases.types.id, typeItem.id, "journal"],
        );
        expect(result.rows).toHaveLength(1);
      }),
    );
    const legacy = await runInTenant(getTenantZeroId(), () => chokePoint.getItem(databases.types.id, typeItem.id));
    if (!legacy) throw new Error("Missing legacy type");
    const renamed = await patch({ name: "Renamed" }, legacy.updatedAt);
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ properties: { name: "Renamed", targetDatabase: "journal" } });
  });

  it("refuses address edits for fresh and cut-over mailboxes over authenticated REST", async () => {
    await seedSystem(pool, createViewTypeRegistry());
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let runtimeServer: Server | undefined;
    const failures: unknown[] = [];
    try {
      const role = await runtime.query<{ name: string; bypass: boolean; superuser: boolean }>(
        "SELECT current_user AS name, rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user",
      );
      expect(role.rows).toEqual([{ name: "semprec_data", bypass: false, superuser: false }]);
      const dispatch = await createDispatcher(runtime, {
        passwordResetMailer: noopMailer,
        appBaseUrl: "http://localhost",
        setupToken: "unused-setup-token",
        moduleRegistry,
        blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
        maxFileSizeBytes: 10 * 1024 * 1024,
      });
      runtimeServer = createServer(dispatch);
      await new Promise<void>((resolve) => runtimeServer?.listen(0, "127.0.0.1", resolve));
      const address = runtimeServer.address();
      if (!address || typeof address === "string") throw new Error("Expected runtime server");
      const base = `http://127.0.0.1:${address.port}`;
      const mailbox = await runInTenant(getTenantZeroId(), () =>
        withTransaction(runtime, async (client) => {
          const db = await getDatabaseByModuleId(client, "mailboxes");
          if (!db) throw new Error("Mailboxes missing");
          const item = await createItemWithClient(client, { databaseId: db.id, properties: { name: "Before" } });
          await updateItemWithClient(
            client,
            { databaseId: db.id, itemId: item.id, propertiesPatch: { addresses: "owner@example.test" } },
            { allowedSystemKeys: ["addresses"] },
          );
          return { id: item.id, dbId: db.id };
        }),
      );
      const url = `${base}/api/items/${mailbox.id}`;
      for (const phase of ["fresh", "cutover"] as const) {
        if (phase === "cutover") {
          // Restore the historical property owner before running the real tenant cutover.
          await pool.query("UPDATE properties SET owner = 'user' WHERE database_id = $1 AND key = 'addresses'", [
            mailbox.dbId,
          ]);
          await runInTenant(getTenantZeroId(), () => runMailboxAddressesOwnerCutoverMigration(runtime));
        }
        const before = await fetch(url, { headers });
        const body = z
          .object({ updatedAt: z.string(), properties: z.record(z.string(), z.unknown()) })
          .parse(await before.json());
        const refused = await fetch(url, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ properties: { addresses: "bad@example.test" }, ifVersion: body.updatedAt }),
        });
        expect(refused.status).toBe(403);
        expect(await refused.json()).toMatchObject({ error: { code: "owner_violation" } });
        const unchanged = z
          .object({ updatedAt: z.string(), properties: z.record(z.string(), z.unknown()) })
          .parse(await (await fetch(url, { headers })).json());
        expect(unchanged).toEqual(body);
        const allowed = await fetch(url, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ properties: { name: `Allowed ${phase}` }, ifVersion: body.updatedAt }),
        });
        expect(allowed.status).toBe(200);
        expect(await allowed.json()).toMatchObject({
          properties: { name: `Allowed ${phase}`, addresses: "owner@example.test" },
        });
      }
    } catch (error) {
      failures.push(error);
    }
    if (runtimeServer) {
      try {
        await new Promise<void>((resolve, reject) =>
          runtimeServer?.close((error) => (error ? reject(error) : resolve())),
        );
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await runtime.end();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "REST test and settlement failed");
  });

  it("refuses generic reason edits while allowing a user-owned field through the runtime route", async () => {
    await seedSystem(pool, createViewTypeRegistry());
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let runtimeServer: Server | undefined;
    const failures: unknown[] = [];
    try {
      const role = await runtime.query<{ name: string; bypass: boolean; superuser: boolean }>(
        "SELECT current_user AS name, rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user",
      );
      expect(role.rows).toEqual([{ name: "semprec_data", bypass: false, superuser: false }]);
      const dispatch = await createDispatcher(runtime, {
        passwordResetMailer: noopMailer,
        appBaseUrl: "http://localhost",
        setupToken: "unused-setup-token",
        moduleRegistry,
        blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
        maxFileSizeBytes: 10 * 1024 * 1024,
      });
      runtimeServer = createServer(dispatch);
      await new Promise<void>((resolve) => runtimeServer?.listen(0, "127.0.0.1", resolve));
      const address = runtimeServer.address();
      if (!address || typeof address === "string") throw new Error("Expected runtime server");
      const base = `http://127.0.0.1:${address.port}`;
      const fixture = await runInTenant(getTenantZeroId(), async () => {
        const proposals = await withTransaction(runtime, (client) =>
          getDatabaseByModuleId(client, "processingProposals"),
        );
        if (!proposals) throw new Error("Processing proposals missing");
        const card = await withTransaction(runtime, (client) =>
          createItemWithClient(
            client,
            { databaseId: proposals.id, properties: { kind: "inbox", reason: "Original" } },
            { allowedSystemKeys: ["kind", "reason"] },
          ),
        );
        const api = createChokePoint(runtime);
        const database = await api.createDatabase({ name: "User fields" });
        await api.createProperty({ databaseId: database.id, key: "note", name: "Note", type: "text" });
        const item = await api.createItem({ databaseId: database.id, properties: { note: "before" } });
        return { card, item };
      });
      const cardUrl = `${base}/api/items/${fixture.card.id}`;
      const schema = z.object({ updatedAt: z.string(), properties: z.record(z.string(), z.unknown()) });
      const before = schema.parse(await (await fetch(cardUrl, { headers })).json());
      const refused = await fetch(cardUrl, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties: { reason: "Injected" }, ifVersion: before.updatedAt }),
      });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: { code: "owner_violation" } });
      expect(schema.parse(await (await fetch(cardUrl, { headers })).json())).toEqual(before);
      const allowed = await fetch(`${base}/api/items/${fixture.item.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties: { note: "after" }, ifVersion: fixture.item.updatedAt }),
      });
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toMatchObject({ properties: { note: "after" } });
    } catch (error) {
      failures.push(error);
    }
    if (runtimeServer) {
      try {
        await new Promise<void>((resolve, reject) =>
          runtimeServer?.close((error) => (error ? reject(error) : resolve())),
        );
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await runtime.end();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "REST test and settlement failed");
  });

  it("queues one mailbox sync through REST flag patches", async () => {
    await seedSystem(pool, createViewTypeRegistry());
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let runtimeServer: Server | undefined;
    try {
      const dispatch = await createDispatcher(runtime, {
        passwordResetMailer: noopMailer,
        appBaseUrl: "http://localhost",
        setupToken: "unused-setup-token",
        moduleRegistry,
        blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
        maxFileSizeBytes: 10 * 1024 * 1024,
      });
      runtimeServer = createServer(dispatch);
      await new Promise<void>((resolve) => runtimeServer?.listen(0, "127.0.0.1", resolve));
      const address = runtimeServer.address();
      if (!address || typeof address === "string") throw new Error("Expected a bound runtime server");
      const runtimeUrl = `http://127.0.0.1:${address.port}`;
      const fixture = await runInTenant(getTenantZeroId(), () =>
        withTransaction(runtime, async (client) => {
          const emails = await getDatabaseByModuleId(client, "emails");
          const mailboxes = await getDatabaseByModuleId(client, "mailboxes");
          if (!emails || !mailboxes) throw new Error("Mail databases were not seeded");
          const mailbox = await createItemWithClient(client, {
            databaseId: mailboxes.id,
            properties: { name: "Work", provider: "generic" },
          });
          const first = await createItemWithClient(client, { databaseId: emails.id, properties: {} });
          const second = await createItemWithClient(client, { databaseId: emails.id, properties: {} });
          for (const [item, messageId] of [
            [first, "<first@example.test>"],
            [second, "<second@example.test>"],
          ] as const) {
            await upsertMailMessageMeta(client, {
              itemId: item.id,
              mailboxItemId: mailbox.id,
              messageId,
              envelope: {},
            });
          }
          return { mailbox, first, second };
        }),
      );
      for (const [item, properties] of [
        [fixture.first, { read: true }],
        [fixture.second, { flagged: true }],
      ] as const) {
        const response = await fetch(`${runtimeUrl}/api/items/${item.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ properties, ifVersion: item.updatedAt }),
        });
        expect(response.status).toBe(200);
      }
      const { rows } = await pool.query<{ key: string | null }>(
        "SELECT key FROM graphile_worker.jobs WHERE task_identifier = $1",
        ["mailAccountSync"],
      );
      expect(rows).toEqual([{ key: `mail-account-sync:${fixture.mailbox.id}` }]);
    } finally {
      if (runtimeServer) await new Promise<void>((resolve) => runtimeServer?.close(() => resolve()));
      await runtime.end();
    }
  });

  it("validates Books ratings through the PATCH HTTP response", async () => {
    await seedSystem(pool, createViewTypeRegistry());
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const database = await runInTenant(getTenantZeroId(), () =>
      withTransaction(pool, (client) => getDatabaseByModuleId(client, "books")),
    );
    if (!database) throw new Error("Missing Books database");
    for (const rating of [7, 2.5, 0, 1, 5]) {
      const item = await runInTenant(getTenantZeroId(), () =>
        chokePoint.createItem({ databaseId: database.id, properties: { name: "Book" } }),
      );
      const response = await fetch(`${baseUrl}/api/items/${item.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties: { rating }, ifVersion: item.updatedAt }),
      });
      if (rating === 7 || rating === 2.5) {
        expect(response.status).toBe(400);
        const body: unknown = await response.json();
        expect(
          z.object({ error: z.object({ code: z.string(), details: z.object({ field: z.string() }) }) }).parse(body),
        ).toMatchObject({ error: { code: "validation_failed", details: { field: "rating" } } });
        const unchanged = await runInTenant(getTenantZeroId(), () => chokePoint.getItem(database.id, item.id));
        expect(unchanged?.properties.rating).toBeUndefined();
      } else {
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        expect(z.object({ properties: z.object({ rating: z.number() }) }).parse(body).properties.rating).toBe(rating);
      }
    }
  });

  it("validates Tasks schedule patches and replays a create through HTTP", async () => {
    await seedSystem(pool, createViewTypeRegistry());
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const database = await runInTenant(getTenantZeroId(), () =>
      withTransaction(pool, (client) => getDatabaseByModuleId(client, "tasks")),
    );
    if (!database) throw new Error("Missing Tasks database");
    const task = await runInTenant(getTenantZeroId(), () =>
      chokePoint.createItem({ databaseId: database.id, properties: { name: "Plan" } }),
    );
    for (const [properties, field] of [
      [{ timeFrom: "10:00" }, "timeFrom"],
      [{ name: "  " }, "name"],
      [{ date: "2026-02-30" }, "date"],
      [{ date: "2026-10-13", timeTo: "15:00" }, "timeTo"],
      [{ date: "2026-10-13", timeFrom: "10:00", timeTo: "09:30" }, "timeTo"],
      [{ date: "2026-10-13", timeFrom: "23:55", timeTo: "23:55" }, "timeTo"],
    ] as const) {
      const response = await fetch(`${baseUrl}/api/items/${task.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties, ifVersion: task.updatedAt }),
      });
      expect(response.status).toBe(400);
      const body: unknown = await response.json();
      expect(body).toMatchObject({ error: { code: "validation_failed", details: { field } } });
      const unchanged = await runInTenant(getTenantZeroId(), () => chokePoint.getItem(database.id, task.id));
      expect(unchanged?.properties).toEqual(task.properties);
      expect(unchanged?.updatedAt).toBe(task.updatedAt);
    }
    const patch = async (properties: Record<string, unknown>, ifVersion: string) => {
      const response = await fetch(`${baseUrl}/api/items/${task.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties, ifVersion }),
      });
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      return z.object({ updatedAt: z.string(), properties: z.record(z.string(), z.unknown()) }).parse(body);
    };
    const normalized = await patch({ date: "2026-10-13", timeFrom: "9:00" }, task.updatedAt);
    expect(normalized.properties).toMatchObject({ timeFrom: "09:00", time: "09:00" });
    const late = await patch({ timeFrom: "23:55", timeTo: "24:00" }, normalized.updatedAt);
    expect(late.properties).toMatchObject({ timeFrom: "23:55", timeTo: "24:00", time: "23:55–24:00" });
    const cleared = await patch({ date: null }, late.updatedAt);
    expect(cleared.properties).toMatchObject({ date: null, timeFrom: null, timeTo: null, time: null });
    const replayHeaders = { ...headers, "Idempotency-Key": randomUUID() };
    const request = () =>
      fetch(`${baseUrl}/api/databases/${database.id}/items`, {
        method: "POST",
        headers: replayHeaders,
        body: JSON.stringify({ properties: { name: "Replay", date: "2026-10-13", timeFrom: "9:00" } }),
      });
    const first = await request();
    const second = await request();
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const itemSchema = z.object({ id: z.string(), properties: z.object({ timeFrom: z.string(), time: z.string() }) });
    const one: unknown = await first.json();
    const two: unknown = await second.json();
    expect(itemSchema.parse(two)).toEqual(itemSchema.parse(one));
    expect(itemSchema.parse(two).properties).toEqual({ timeFrom: "09:00", time: "09:00" });
  });

  it("validates watchedWith ratings through the PUT HTTP response", async () => {
    await seedSystem(pool, createViewTypeRegistry());
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const fixture = await runInTenant(getTenantZeroId(), async () => {
      const movies = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "movies"));
      const people = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "people"));
      if (!movies || !people) throw new Error("Missing Movies or People database");
      return {
        movie: await chokePoint.createItem({ databaseId: movies.id, properties: { name: "Film" } }),
        person: await chokePoint.createItem({ databaseId: people.id, properties: { name: "Person" } }),
      };
    });
    const url = `${baseUrl}/api/items/${fixture.movie.id}/relations/watchedWith/${fixture.person.id}`;
    const invalid = await fetch(url, { method: "PUT", headers, body: JSON.stringify({ metadata: { rating: 9 } }) });
    expect(invalid.status).toBe(400);
    const error: unknown = await invalid.json();
    expect(
      z.object({ error: z.object({ code: z.string(), details: z.object({ field: z.string() }) }) }).parse(error),
    ).toMatchObject({ error: { code: "validation_failed", details: { field: "metadata.rating" } } });
    const edgeCount = await runInTenant(getTenantZeroId(), () =>
      withTransaction(pool, async (client) => {
        const result = await client.query<Record<string, unknown>>(
          "SELECT count(*)::int AS count FROM item_relations WHERE (item_a = $1 AND item_b = $2) OR (item_a = $2 AND item_b = $1)",
          [fixture.movie.id, fixture.person.id],
        );
        return z.object({ count: z.number() }).parse(result.rows[0]).count;
      }),
    );
    expect(edgeCount).toBe(0);
    for (const metadata of [{ rating: 4 }, {}]) {
      const response = await fetch(url, { method: "PUT", headers, body: JSON.stringify({ metadata }) });
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(z.object({ metadata: z.record(z.string(), z.unknown()) }).parse(body).metadata).toEqual(metadata);
    }
  });

  it("leaves the same rating keys on another module unaffected over HTTP", async () => {
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const fixture = await runInTenant(getTenantZeroId(), async () => {
      const source = await chokePoint.createDatabase({ name: "Other" });
      const target = await chokePoint.createDatabase({ name: "People" });
      await chokePoint.createProperty({ databaseId: source.id, key: "rating", name: "Rating", type: "number" });
      await chokePoint.createRelationProperty({
        sourceDatabaseId: source.id,
        key: "watchedWith",
        name: "Watched with",
        targetDatabaseId: target.id,
      });
      return {
        item: await chokePoint.createItem({ databaseId: source.id, properties: {} }),
        person: await chokePoint.createItem({ databaseId: target.id, properties: {} }),
      };
    });
    const patch = await fetch(`${baseUrl}/api/items/${fixture.item.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ properties: { rating: 7 }, ifVersion: fixture.item.updatedAt }),
    });
    expect(patch.status).toBe(200);
    const patchBody: unknown = await patch.json();
    expect(z.object({ properties: z.object({ rating: z.number() }) }).parse(patchBody).properties.rating).toBe(7);
    const edge = await fetch(`${baseUrl}/api/items/${fixture.item.id}/relations/watchedWith/${fixture.person.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ metadata: { rating: 9 } }),
    });
    expect(edge.status).toBe(200);
    const edgeBody: unknown = await edge.json();
    expect(z.object({ metadata: z.object({ rating: z.number() }) }).parse(edgeBody).metadata.rating).toBe(9);
  });

  it("refuses foreign and forbidden file-step inputs over HTTP without writes, then confirms its own attachment", async () => {
    await seedSystem(pool, createViewTypeRegistry());
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const fixture = await runInTenant(getTenantZeroId(), async () => {
      const idFor = async (module: string) => {
        const row = await withTransaction(pool, (client) => getDatabaseByModuleId(client, module));
        if (!row) throw new Error(`Missing ${module}`);
        return row.id;
      };
      const inboxDatabaseId = await idFor("inbox");
      const inboxItemTypesDatabaseId = await idFor("inboxItemTypes");
      const processingProposalsDatabaseId = await idFor("processingProposals");
      const tasks = await idFor("tasks");
      const files = await idFor("files");
      const type = await chokePoint.createItem({
        databaseId: inboxItemTypesDatabaseId,
        properties: { name: "Task", emoji: "T", processingMethod: "database", targetDatabase: "tasks" },
      });
      const source = await chokePoint.createItem({
        databaseId: inboxDatabaseId,
        properties: { text: "Own", date: "2026-08-28", time: "09:00" },
      });
      const foreign = await chokePoint.createItem({
        databaseId: inboxDatabaseId,
        properties: { text: "Other", date: "2026-08-28", time: "09:00" },
      });
      const typeProperty = (await chokePoint.listProperties(inboxDatabaseId)).find((entry) => entry.key === "type");
      if (!typeProperty) throw new Error("Missing Inbox type relation");
      await chokePoint.createRelation({
        relationPropertyId: typeProperty.id,
        callerItemId: source.id,
        targetItemId: type.id,
      });
      const attachment = await withTransaction(pool, async (client) => {
        const ownBlob = await createBlob(client, {
          mimeType: "image/jpeg",
          byteSize: 3,
          storageKey: `${getTenantZeroId()}/blobs/${randomUUID()}`,
        });
        const otherBlob = await createBlob(client, {
          mimeType: "image/jpeg",
          byteSize: 3,
          storageKey: `${getTenantZeroId()}/blobs/${randomUUID()}`,
        });
        await insertInboxAttachments(client, source.id, [{ blobId: ownBlob.id, source: "camera" }]);
        await insertInboxAttachments(client, foreign.id, [{ blobId: otherBlob.id, source: "camera" }]);
        const own = await listInboxAttachments(client, [source.id]);
        const other = await listInboxAttachments(client, [foreign.id]);
        if (!own[0] || !other[0]) throw new Error("Missing test attachments");
        return { own: own[0].attachmentId, foreign: other[0].attachmentId, blobId: ownBlob.id };
      });
      const tick = createSemprecTickAction(pool, async () => ({ properties: { name: "Task" } }));
      await tick(
        { inboxDatabaseId, inboxItemTypesDatabaseId, processingProposalsDatabaseId },
        { heartbeatId: "hb", projectItemId: "proj", itemId: source.id },
      );
      const cards = await chokePoint.listItems(processingProposalsDatabaseId);
      if (cards.items.length !== 1 || !cards.items[0]) throw new Error("Missing proposal card");
      return { source, foreign, attachment, tasks, files, processingProposalsDatabaseId, cardId: cards.items[0].id };
    });
    const store = async (properties: Record<string, unknown>) =>
      runInTenant(getTenantZeroId(), () =>
        withTransaction(pool, (client) =>
          updateItemWithClient(
            client,
            {
              databaseId: fixture.processingProposalsDatabaseId,
              itemId: fixture.cardId,
              propertiesPatch: {
                proposal: {
                  entityKind: "database",
                  target: fixture.tasks,
                  properties: { name: "Task" },
                  operations: [
                    { ref: "task", op: "create", role: "primary", databaseKey: "tasks", properties: { name: "Task" } },
                    { ref: "file", op: "fileFromAttachment", role: "secondary", properties },
                  ],
                },
              },
            },
            { allowedSystemKeys: ["proposal"] },
          ),
        ),
      );
    const snapshot = async () => {
      const card = await runInTenant(getTenantZeroId(), () =>
        chokePoint.getItem(fixture.processingProposalsDatabaseId, fixture.cardId),
      );
      const items = await pool.query<Record<string, unknown>>(
        "SELECT id, properties FROM items WHERE database_id = ANY($1::uuid[]) ORDER BY id",
        [[fixture.tasks, fixture.files]],
      );
      const attachments = await runInTenant(getTenantZeroId(), () =>
        withTransaction(pool, (client) => listInboxAttachments(client, [fixture.source.id, fixture.foreign.id])),
      );
      return {
        card,
        items: z.array(z.object({ id: z.uuid(), properties: z.record(z.string(), z.unknown()) })).parse(items.rows),
        attachments,
      };
    };
    for (const [properties, field] of [
      [{ attachmentId: fixture.attachment.foreign, name: "Photo" }, "attachmentId"],
      [{ attachmentId: fixture.attachment.own, name: "Photo", file: { blobId: fixture.attachment.blobId } }, "file"],
      [{ attachmentId: fixture.attachment.own, name: "Photo", type: "jpg" }, "type"],
      [{ attachmentId: fixture.attachment.own, name: "Photo", untrusted: true }, "untrusted"],
    ] as const) {
      await store(properties);
      const before = await snapshot();
      const response = await fetch(`${baseUrl}/api/proposals/${fixture.cardId}/confirm`, { method: "POST", headers });
      expect(response.status).toBe(400);
      const body: unknown = await response.json();
      expect(
        z
          .object({ error: z.object({ code: z.string(), details: z.object({ ref: z.string(), field: z.string() }) }) })
          .parse(body).error,
      ).toMatchObject({ code: "validation_failed", details: { ref: "file", field } });
      expect(await snapshot()).toEqual(before);
    }
    await store({ attachmentId: fixture.attachment.own, name: "Photo" });
    const success = await fetch(`${baseUrl}/api/proposals/${fixture.cardId}/confirm`, { method: "POST", headers });
    expect(success.status).toBe(200);
    const response: unknown = await success.json();
    expect(
      z.object({ properties: z.object({ status: z.string(), resultItemId: z.uuid() }) }).parse(response).properties
        .status,
    ).toBe("confirmed");
    const after = await snapshot();
    expect(after.attachments.map((item) => item.attachmentId)).toEqual([fixture.attachment.foreign]);
    expect(
      after.items.some(
        (item) =>
          z.object({ file: z.object({ blobId: z.uuid() }).optional() }).parse(item.properties).file?.blobId ===
          fixture.attachment.blobId,
      ),
    ).toBe(true);
  });

  it("projects confirmed Inbox origin through item, database and view HTTP reads", async () => {
    await seedSystem(pool, createViewTypeRegistry());
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const fixture = await runInTenant(getTenantZeroId(), async () => {
      const idFor = async (moduleId: string) =>
        withTransaction(pool, async (client) => {
          const database = await getDatabaseByModuleId(client, moduleId);
          if (!database) throw new Error(`Missing database ${moduleId}`);
          return database.id;
        });
      const inboxDatabaseId = await idFor("inbox");
      const inboxItemTypesDatabaseId = await idFor("inboxItemTypes");
      const processingProposalsDatabaseId = await idFor("processingProposals");
      const filesId = await idFor("files");
      const companiesId = await idFor("companies");
      const peopleId = await idFor("people");
      const type = await chokePoint.createItem({
        databaseId: inboxItemTypesDatabaseId,
        properties: {
          name: "File",
          emoji: "📄",
          processingMethod: "database",
          targetDatabase: "files",
        },
      });
      const source = await chokePoint.createItem({
        databaseId: inboxDatabaseId,
        properties: {
          text: "A file",
          date: "2026-08-28",
          time: "09:00",
        },
      });
      const property = await pool.query<{ id: string }>(
        "SELECT id FROM properties WHERE database_id = $1 AND key = 'type'",
        [inboxDatabaseId],
      );
      if (!property.rows[0]) throw new Error("Missing Inbox type property");
      await chokePoint.createRelation({
        relationPropertyId: property.rows[0].id,
        callerItemId: source.id,
        targetItemId: type.id,
      });
      const tick = createSemprecTickAction(pool, async () => ({ properties: { name: "From Inbox" } }));
      await tick(
        { inboxDatabaseId, inboxItemTypesDatabaseId, processingProposalsDatabaseId },
        { heartbeatId: "hb", projectItemId: "proj", itemId: source.id },
      );
      const cards = await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1", [
        processingProposalsDatabaseId,
      ]);
      if (cards.rows.length !== 1 || !cards.rows[0]) throw new Error("Expected one proposal");
      const view = await chokePoint.createView({ databaseId: filesId, type: "list", name: "Files", config: {} });
      return {
        filesId,
        companiesId,
        peopleId,
        processingProposalsDatabaseId,
        cardId: cards.rows[0].id,
        viewId: view.id,
      };
    });
    const originalCard = await runInTenant(getTenantZeroId(), () =>
      chokePoint.getItem(fixture.processingProposalsDatabaseId, fixture.cardId),
    );
    if (!originalCard) throw new Error("Missing proposal card");
    const initialProposal = originalCard.properties.proposal;
    const countTargets = async () =>
      (
        await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM items WHERE database_id = ANY($1::uuid[])",
          [[fixture.companiesId, fixture.peopleId]],
        )
      ).rows[0]?.count;
    const originalCount = await countTargets();
    const countEdges = async () =>
      (await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM item_relations")).rows[0]?.count;
    const originalEdges = await countEdges();
    for (const [properties, field] of [
      [{ name: "Jane", bogus: 1 }, "bogus"],
      [{ name: 42 }, "name"],
    ] as const) {
      const company = {
        ref: "company",
        op: "create",
        databaseKey: "companies",
        role: "primary",
        properties: { name: "Acme" },
      };
      const person = {
        ref: "person",
        op: "create",
        databaseKey: "people",
        role: "secondary",
        properties,
        relations: { companies: [{ ref: "company" }] },
      };
      await runInTenant(getTenantZeroId(), () =>
        withTransaction(pool, (client) =>
          updateItemWithClient(
            client,
            {
              databaseId: fixture.processingProposalsDatabaseId,
              itemId: fixture.cardId,
              propertiesPatch: {
                proposal: {
                  entityKind: "database",
                  target: fixture.companiesId,
                  properties: company.properties,
                  operations: [company, person],
                },
              },
            },
            { allowedSystemKeys: ["proposal"] },
          ),
        ),
      );
      const before = await runInTenant(getTenantZeroId(), () =>
        chokePoint.getItem(fixture.processingProposalsDatabaseId, fixture.cardId),
      );
      const failure = await fetch(`${baseUrl}/api/proposals/${fixture.cardId}/confirm`, {
        method: "POST",
        headers,
        body: "{}",
      });
      expect(failure.status).toBe(400);
      expect(
        z
          .object({ error: z.object({ details: z.object({ ref: z.string(), field: z.string() }) }) })
          .parse(await failure.json()).error.details,
      ).toEqual({ ref: "person", field });
      const after = await runInTenant(getTenantZeroId(), () =>
        chokePoint.getItem(fixture.processingProposalsDatabaseId, fixture.cardId),
      );
      expect(after).toEqual(before);
      expect(after?.properties.status).toBe("proposed");
      expect(await countTargets()).toBe(originalCount);
      expect(await countEdges()).toBe(originalEdges);
    }
    const futureEnvelope = {
      entityKind: "someFutureKind",
      target: fixture.companiesId,
      properties: { name: "Future" },
    };
    await runInTenant(getTenantZeroId(), () =>
      withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          {
            databaseId: fixture.processingProposalsDatabaseId,
            itemId: fixture.cardId,
            propertiesPatch: { proposal: futureEnvelope },
          },
          { allowedSystemKeys: ["proposal"] },
        ),
      ),
    );
    const futureBefore = await runInTenant(getTenantZeroId(), () =>
      chokePoint.getItem(fixture.processingProposalsDatabaseId, fixture.cardId),
    );
    const unsupported = await fetch(`${baseUrl}/api/proposals/${fixture.cardId}/confirm`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(unsupported.status).toBe(409);
    const conflict = z
      .object({
        error: z.object({ code: z.string(), details: z.object({ field: z.string(), entityKind: z.string() }) }),
      })
      .parse(await unsupported.json());
    expect(conflict.error).toEqual({
      code: "version_conflict",
      details: { field: "entityKind", entityKind: "someFutureKind" },
    });
    expect(
      await runInTenant(getTenantZeroId(), () =>
        chokePoint.getItem(fixture.processingProposalsDatabaseId, fixture.cardId),
      ),
    ).toEqual(futureBefore);
    expect(futureBefore?.properties.status).toBe("proposed");
    expect(await countTargets()).toBe(originalCount);
    expect(await countEdges()).toBe(originalEdges);
    await runInTenant(getTenantZeroId(), () =>
      withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          {
            databaseId: fixture.processingProposalsDatabaseId,
            itemId: fixture.cardId,
            propertiesPatch: { proposal: initialProposal },
          },
          { allowedSystemKeys: ["proposal"] },
        ),
      ),
    );
    const confirmed = await fetch(`${baseUrl}/api/proposals/${fixture.cardId}/confirm`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(confirmed.status).toBe(200);
    const card = z.object({ properties: z.object({ resultItemId: z.string() }) }).parse(await confirmed.json());
    const manual = await fetch(`${baseUrl}/api/databases/${fixture.filesId}/items`, {
      method: "POST",
      headers,
      body: JSON.stringify({ properties: { name: "Manual" } }),
    });
    expect(manual.status).toBe(201);
    const manualBody = z.object({ id: z.string(), fromInbox: z.boolean().optional() }).parse(await manual.json());
    expect(manualBody.fromInbox).toBeUndefined();
    const schema = z.object({ id: z.string(), fromInbox: z.boolean() });
    for (const [id, expected] of [
      [card.properties.resultItemId, true],
      [manualBody.id, false],
    ] as const) {
      const response = await fetch(`${baseUrl}/api/items/${id}`, { headers });
      expect(response.status).toBe(200);
      expect(schema.parse(await response.json())).toMatchObject({ id, fromInbox: expected });
    }
    for (const url of [`/api/databases/${fixture.filesId}/query`, `/api/views/${fixture.viewId}/query`]) {
      const response = await fetch(`${baseUrl}${url}`, { method: "POST", headers, body: "{}" });
      expect(response.status).toBe(200);
      const page = z.object({ items: z.array(schema) }).parse(await response.json());
      expect(Object.fromEntries(page.items.map((item) => [item.id, item.fromInbox]))).toEqual({
        [card.properties.resultItemId]: true,
        [manualBody.id]: false,
      });
    }
  });

  it.each(["item get", "database query", "view query", "patch", "conflict"])(
    "sanitizes Emails.body on REST %s",
    async (path) => {
      await seedSystem(pool, createViewTypeRegistry());
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const raw = '<p onclick="evil()">safe</p><script>evil()</script><img src="https://tracker.example/pixel">';
      const item = await withTransaction(pool, async (client) => {
        const database = await getDatabaseByModuleId(client, "emails");
        if (!database) throw new Error("Emails not seeded");
        return createItemWithClient(
          client,
          { databaseId: database.id, properties: { body: raw } },
          { allowedSystemKeys: ["body"] },
        );
      });

      let url = `/api/items/${item.id}`;
      let method = "GET";
      let payload: unknown;
      if (path === "database query") {
        url = `/api/databases/${item.databaseId}/query`;
        method = "POST";
        payload = {};
      }
      if (path === "view query") {
        const view = await chokePoint.createView({
          databaseId: item.databaseId,
          type: "list",
          name: "Projection test",
          config: {},
        });
        url = `/api/views/${view.id}/query`;
        method = "POST";
        payload = {};
      }
      if (path === "patch" || path === "conflict") {
        method = "PATCH";
        payload = {
          properties: { read: true },
          ifVersion: path === "conflict" ? "2000-01-01T00:00:00.000Z" : item.updatedAt,
        };
      }
      const response = await fetch(`${baseUrl}${url}`, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      expect(response.status).toBe(path === "conflict" ? 409 : 200);
      const body: unknown = await response.json();
      const envelope = z.object({ properties: z.object({ body: z.string() }) });
      let html: string;
      if (path === "conflict")
        html = z.object({ error: z.object({ details: z.object({ currentItem: envelope }) }) }).parse(body).error.details
          .currentItem.properties.body;
      else if (path.endsWith("query"))
        html = z.object({ items: z.array(envelope).min(1) }).parse(body).items[0]!.properties.body;
      else html = envelope.parse(body).properties.body;
      expect(html).toContain("safe");
      expect(html).not.toMatch(/<script|onclick|https:\/\/tracker/i);
    },
  );

  async function makeMoviesDb() {
    const db = await chokePoint.createDatabase({ name: "Movies" });
    await chokePoint.createProperty({ databaseId: db.id, key: "title", name: "Title", type: "text" });
    return db;
  }

  describe("create", () => {
    it("creates initial relations atomically and replays the idempotency key over REST", async () => {
      const headers = { ...(await authHeader()), "Content-Type": "application/json", "Idempotency-Key": randomUUID() };
      const fixture = await runInTenant(getTenantZeroId(), async () => {
        const source = await chokePoint.createDatabase({ name: "Source" });
        const target = await chokePoint.createDatabase({ name: "Target" });
        const { property } = await chokePoint.createRelationProperty({
          sourceDatabaseId: source.id,
          targetDatabaseId: target.id,
          key: "project",
          name: "Project",
          cardinality: "one_to_one",
        });
        const first = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        const second = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        return { source, property, first, second };
      });
      const create = (targetItemId: string, key = headers["Idempotency-Key"]) =>
        fetch(`${baseUrl}/api/databases/${fixture.source.id}/items`, {
          method: "POST",
          headers: { ...headers, "Idempotency-Key": key },
          body: JSON.stringify({
            properties: {},
            relations: [{ propertyKey: "project", targetItemIds: [targetItemId] }],
          }),
        });
      const first = await create(fixture.first.id);
      expect(first.status).toBe(201);
      const item = z
        .object({ id: z.string().uuid() })
        .passthrough()
        .parse(await first.json());
      const replay = await create(fixture.second.id);
      expect(replay.status).toBe(201);
      expect(
        z
          .object({ id: z.string() })
          .passthrough()
          .parse(await replay.json()).id,
      ).toBe(item.id);
      const replayWithMissingTarget = await create(randomUUID());
      expect(replayWithMissingTarget.status).toBe(201);
      expect(z.object({ id: z.string().uuid() }).parse(await replayWithMissingTarget.json()).id).toBe(item.id);
      expect(
        await runInTenant(getTenantZeroId(), () => chokePoint.listItemRelations(item.id, fixture.property.id)),
      ).toMatchObject([{ targetItemId: fixture.first.id }]);
      const before = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
        fixture.source.id,
      ]);
      const refused = await create(randomUUID(), randomUUID());
      expect(refused.status).toBe(400);
      expect(
        (
          await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
            fixture.source.id,
          ])
        ).rows,
      ).toEqual(before.rows);
    });
    it("rejects an unauthenticated request", async () => {
      const res = await fetch(`${baseUrl}/api/databases/${randomUUID()}/items`, { method: "POST" });
      expect(res.status).toBe(401);
    });

    it("creates an item and returns 201 with the full row", async () => {
      const db = await makeMoviesDb();
      const headers = { ...(await authHeader()), "Content-Type": "application/json", "Idempotency-Key": randomUUID() };

      const res = await fetch(`${baseUrl}/api/databases/${db.id}/items`, {
        method: "POST",
        headers,
        body: JSON.stringify({ properties: { title: "Arrival" } }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as ItemBody;
      expect(body.databaseId).toBe(db.id);
      expect(body.properties).toEqual({ title: "Arrival" });
    });

    it("creates an item with no Idempotency-Key header (optional per the generic catalog)", async () => {
      const db = await makeMoviesDb();
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const res = await fetch(`${baseUrl}/api/databases/${db.id}/items`, {
        method: "POST",
        headers,
        body: JSON.stringify({ properties: { title: "Arrival" } }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as ItemBody;
      expect(body.properties).toEqual({ title: "Arrival" });
    });

    it("repeating the same Idempotency-Key returns the original row without a second insert", async () => {
      const db = await makeMoviesDb();
      const key = randomUUID();
      const headers = { ...(await authHeader()), "Content-Type": "application/json", "Idempotency-Key": key };

      const first = await fetch(`${baseUrl}/api/databases/${db.id}/items`, {
        method: "POST",
        headers,
        body: JSON.stringify({ properties: { title: "Dune" } }),
      });
      const firstBody = (await first.json()) as ItemBody;

      const second = await fetch(`${baseUrl}/api/databases/${db.id}/items`, {
        method: "POST",
        headers,
        body: JSON.stringify({ properties: { title: "Dune 2" } }),
      });
      expect(second.status).toBe(201);
      const secondBody = (await second.json()) as ItemBody;
      expect(secondBody.id).toBe(firstBody.id);
      expect(secondBody.properties).toEqual({ title: "Dune" });

      const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [db.id]);
      expect(rows[0].n).toBe(1);
    });

    it("rejects a create against an archived database with 403 database_archived", async () => {
      const db = await makeMoviesDb();
      await chokePoint.archiveDatabase(db.id);
      const headers = { ...(await authHeader()), "Content-Type": "application/json", "Idempotency-Key": randomUUID() };

      const res = await fetch(`${baseUrl}/api/databases/${db.id}/items`, {
        method: "POST",
        headers,
        body: JSON.stringify({ properties: { title: "Arrival" } }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("database_archived");
    });

    it("refuses a Journal entry posted without its type and period with 403 and stores no row", async () => {
      await seedSystem(pool, createViewTypeRegistry());
      const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'journal'");
      const journal = rows[0];
      if (!journal) throw new Error("expected the journal database to be seeded");
      const base = { ...(await authHeader()), "Content-Type": "application/json" };

      for (const payload of [{}, { properties: {} }]) {
        const res = await fetch(`${baseUrl}/api/databases/${journal.id}/items`, {
          method: "POST",
          headers: { ...base, "Idempotency-Key": randomUUID() },
          body: JSON.stringify(payload),
        });
        expect(res.status).toBe(403);
        const body = (await res.json()) as ErrorBody;
        expect(body.error.code).toBe("forbidden");
        expect(body.error.details).toEqual({ field: "type" });
      }

      const count = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
        journal.id,
      ]);
      expect(count.rows[0]?.n).toBe(0);
    });
  });

  describe("detail", () => {
    it("rejects an unauthenticated request", async () => {
      const res = await fetch(`${baseUrl}/api/items/${randomUUID()}`);
      expect(res.status).toBe(401);
    });

    it("returns 404 for an unknown item", async () => {
      const headers = await authHeader();
      const res = await fetch(`${baseUrl}/api/items/${randomUUID()}`, { headers });
      expect(res.status).toBe(404);
    });

    it("returns 400 validation_failed naming 'id' for a non-UUID item id", async () => {
      const headers = await authHeader();
      const res = await fetch(`${baseUrl}/api/items/foo`, { headers });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("validation_failed");
      expect(body.error.details).toEqual({ field: "id" });
    });

    it("returns 404 for an unknown item even with ?include=path", async () => {
      const headers = await authHeader();
      const res = await fetch(`${baseUrl}/api/items/${randomUUID()}?include=path`, { headers });
      expect(res.status).toBe(404);
    });

    it("returns the item without a path by default", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      const headers = await authHeader();

      const res = await fetch(`${baseUrl}/api/items/${item.id}`, { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ItemBody;
      expect(body.id).toBe(item.id);
      expect(body.path).toBeUndefined();
    });

    it("assembles the full ancestor chain for a row nested several inline databases deep", async () => {
      const headers = await authHeader();

      const rootDb = await chokePoint.createDatabase({ name: "Root" });
      const rootItem = await chokePoint.createItem({ databaseId: rootDb.id, properties: {} });

      const midDb = await chokePoint.createInlineDatabase({ name: "Mid", parentItemId: rootItem.id });
      const midItem = await chokePoint.createItem({ databaseId: midDb.id, properties: {} });

      const leafDb = await chokePoint.createInlineDatabase({ name: "Leaf", parentItemId: midItem.id });
      const leafItem = await chokePoint.createItem({ databaseId: leafDb.id, properties: {} });

      const res = await fetch(`${baseUrl}/api/items/${leafItem.id}?include=path`, { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ItemBody;
      expect(body.path?.map((i) => i.id)).toEqual([rootItem.id, midItem.id, leafItem.id]);
    });

    it("returns a single-entry path for a top-level row, same shape as a nested one", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      const headers = await authHeader();

      const res = await fetch(`${baseUrl}/api/items/${item.id}?include=path`, { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ItemBody;
      expect(body.path?.map((i) => i.id)).toEqual([item.id]);
    });
  });

  describe("patch", () => {
    it("rejects an unauthenticated request", async () => {
      const res = await fetch(`${baseUrl}/api/items/${randomUUID()}`, { method: "PATCH" });
      expect(res.status).toBe(401);
    });

    it("merges a properties patch by key and returns 200 with the full row", async () => {
      const db = await chokePoint.createDatabase({ name: "D" });
      await chokePoint.createProperty({ databaseId: db.id, key: "title", name: "Title", type: "text" });
      await chokePoint.createProperty({ databaseId: db.id, key: "year", name: "Year", type: "number" });
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune", year: 2021 } });
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const res = await fetch(`${baseUrl}/api/items/${item.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties: { title: "Dune (2021)" }, ifVersion: item.updatedAt }),
      });
      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      expect(body).toEqual({
        id: item.id,
        databaseId: db.id,
        properties: { title: "Dune (2021)", year: 2021 },
        computed: item.computed,
        // The creation time is the create's, unchanged by the patch (issue #1594).
        createdAt: item.createdAt,
        updatedAt: expect.any(String),
        deletedAt: null,
      });
      expect(body).not.toHaveProperty("previous");
    });

    it("rejects a patch body with no properties field with a 'required' message, not a type error", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const res = await fetch(`${baseUrl}/api/items/${item.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ ifVersion: item.updatedAt }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("validation_failed");
    });

    it("writes a REST PATCH as the user writer", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const writers: WriterIdentity[] = [];
      // Hooks cannot be unregistered; this recorder only appends to this test's array.
      registerItemUpdateHook(async (context) => {
        writers.push(context.writer);
      });

      const res = await fetch(`${baseUrl}/api/items/${item.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties: { title: "Dune: Part Two" }, ifVersion: item.updatedAt }),
      });

      expect(res.status).toBe(200);
      expect(writers).toEqual([{ writerKind: "user" }]);
    });

    it("rejects caller-supplied writerKind on create and patch without writing", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const created: WriterIdentity[] = [];
      const updated: WriterIdentity[] = [];
      // Hooks cannot be unregistered; these recorders only append to this test's arrays.
      registerItemCreateHook(async (context) => {
        created.push(context.writer);
      });
      registerItemUpdateHook(async (context) => {
        updated.push(context.writer);
      });

      const patch = await fetch(`${baseUrl}/api/items/${item.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties: { title: "Changed" }, ifVersion: item.updatedAt, writerKind: "system" }),
      });
      const create = await fetch(`${baseUrl}/api/databases/${db.id}/items`, {
        method: "POST",
        headers,
        body: JSON.stringify({ properties: { title: "New" }, writerKind: "system" }),
      });

      expect(patch.status).toBe(400);
      const patchBody: unknown = await patch.json();
      expect(patchBody).toMatchObject({ error: { code: "validation_failed", details: { field: "writerKind" } } });
      expect(create.status).toBe(400);
      const createBody: unknown = await create.json();
      expect(createBody).toMatchObject({ error: { code: "validation_failed", details: { field: "writerKind" } } });
      expect(updated).toEqual([]);
      expect(created).toEqual([]);
      expect((await chokePoint.getItem(db.id, item.id))?.properties).toEqual({ title: "Dune" });
    });

    it("returns 404 patching an unknown item", async () => {
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const res = await fetch(`${baseUrl}/api/items/${randomUUID()}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties: {}, ifVersion: new Date().toISOString() }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 409 version_conflict with details.currentItem on a stale ifVersion", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      await fetch(`${baseUrl}/api/items/${item.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties: { title: "Dune (2021)" }, ifVersion: item.updatedAt }),
      });

      const res = await fetch(`${baseUrl}/api/items/${item.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties: { title: "Dune Part Two" }, ifVersion: item.updatedAt }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as ErrorBody & { error: { details: { currentItem: ItemBody } } };
      expect(body.error.code).toBe("version_conflict");
      expect(body.error.details.currentItem.id).toBe(item.id);
      expect(body.error.details.currentItem.properties).toEqual({ title: "Dune (2021)" });
    });

    it("rejects a write to a rollup-typed property with 403 computed_readonly", async () => {
      const source = await chokePoint.createDatabase({ name: "P" });
      const target = await chokePoint.createDatabase({ name: "T" });
      const { property: relation } = await chokePoint.createRelationProperty({
        sourceDatabaseId: source.id,
        key: "tasks",
        name: "Tasks",
        targetDatabaseId: target.id,
      });
      const rollup = await chokePoint.createProperty({
        databaseId: source.id,
        key: "count",
        name: "Count",
        type: "rollup",
        config: { relationPropertyKey: relation.key, aggregation: "count" },
      });
      const item = await chokePoint.createItem({ databaseId: source.id, properties: {} });
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const res = await fetch(`${baseUrl}/api/items/${item.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties: { [rollup.key]: 5 }, ifVersion: item.updatedAt }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("computed_readonly");
    });

    it("rejects a patch against an archived database with 403 database_archived", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      await chokePoint.archiveDatabase(db.id);
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const res = await fetch(`${baseUrl}/api/items/${item.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties: { title: "Dune (2021)" }, ifVersion: item.updatedAt }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("database_archived");
    });
  });

  describe("delete (issue #156)", () => {
    it("rejects an unauthenticated request", async () => {
      const res = await fetch(`${baseUrl}/api/items/${randomUUID()}`, { method: "DELETE" });
      expect(res.status).toBe(401);
    });

    it("returns 404 deleting an unknown item", async () => {
      const headers = await authHeader();
      const res = await fetch(`${baseUrl}/api/items/${randomUUID()}`, { method: "DELETE", headers });
      expect(res.status).toBe(404);
    });

    it("soft-deletes an item and returns 200 with the full row, never 204", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      const headers = await authHeader();

      const res = await fetch(`${baseUrl}/api/items/${item.id}`, { method: "DELETE", headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ItemBody;
      expect(body.id).toBe(item.id);
      expect(body.deletedAt).not.toBeNull();
    });

    it("cascades the delete through nested inline databases", async () => {
      const headers = await authHeader();
      const rootDb = await chokePoint.createDatabase({ name: "Root" });
      const rootItem = await chokePoint.createItem({ databaseId: rootDb.id, properties: {} });
      const midDb = await chokePoint.createInlineDatabase({ name: "Mid", parentItemId: rootItem.id });
      const midItem = await chokePoint.createItem({ databaseId: midDb.id, properties: {} });

      const res = await fetch(`${baseUrl}/api/items/${rootItem.id}`, { method: "DELETE", headers });
      expect(res.status).toBe(200);

      const midAfter = await chokePoint.getItem(midDb.id, midItem.id);
      expect(midAfter?.deletedAt).not.toBeNull();
    });

    it("repeating the delete on an already-trashed item is idempotent, not a 404", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      const headers = await authHeader();

      await fetch(`${baseUrl}/api/items/${item.id}`, { method: "DELETE", headers });
      const res = await fetch(`${baseUrl}/api/items/${item.id}`, { method: "DELETE", headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ItemBody;
      expect(body.id).toBe(item.id);
    });

    it("rejects a delete against an archived database with 403 database_archived", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      await chokePoint.archiveDatabase(db.id);
      const headers = await authHeader();

      const res = await fetch(`${baseUrl}/api/items/${item.id}`, { method: "DELETE", headers });
      expect(res.status).toBe(403);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("database_archived");
    });
  });

  describe("restore (issue #156)", () => {
    it("rejects an unauthenticated request", async () => {
      const res = await fetch(`${baseUrl}/api/items/${randomUUID()}/restore`, { method: "POST" });
      expect(res.status).toBe(401);
    });

    it("returns 404 restoring an unknown item", async () => {
      const headers = await authHeader();
      const res = await fetch(`${baseUrl}/api/items/${randomUUID()}/restore`, { method: "POST", headers });
      expect(res.status).toBe(404);
    });

    it("restores a trashed item and returns 200 with the full row, never 204", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      const headers = await authHeader();
      await fetch(`${baseUrl}/api/items/${item.id}`, { method: "DELETE", headers });

      const res = await fetch(`${baseUrl}/api/items/${item.id}/restore`, { method: "POST", headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ItemBody;
      expect(body.id).toBe(item.id);
      expect(body.deletedAt).toBeNull();
    });

    it("cascades the restore through nested inline databases", async () => {
      const headers = await authHeader();
      const rootDb = await chokePoint.createDatabase({ name: "Root" });
      const rootItem = await chokePoint.createItem({ databaseId: rootDb.id, properties: {} });
      const midDb = await chokePoint.createInlineDatabase({ name: "Mid", parentItemId: rootItem.id });
      const midItem = await chokePoint.createItem({ databaseId: midDb.id, properties: {} });
      await fetch(`${baseUrl}/api/items/${rootItem.id}`, { method: "DELETE", headers });

      const res = await fetch(`${baseUrl}/api/items/${rootItem.id}/restore`, { method: "POST", headers });
      expect(res.status).toBe(200);

      const midAfter = await chokePoint.getItem(midDb.id, midItem.id);
      expect(midAfter?.deletedAt).toBeNull();
    });

    it("repeating the restore on an already-live item is idempotent, not a 404", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      const headers = await authHeader();

      const res = await fetch(`${baseUrl}/api/items/${item.id}/restore`, { method: "POST", headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ItemBody;
      expect(body.id).toBe(item.id);
      expect(body.deletedAt).toBeNull();
    });

    it("rejects a restore against an archived database with 403 database_archived", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      const headers = await authHeader();
      await fetch(`${baseUrl}/api/items/${item.id}`, { method: "DELETE", headers });
      await chokePoint.archiveDatabase(db.id);

      const res = await fetch(`${baseUrl}/api/items/${item.id}/restore`, { method: "POST", headers });
      expect(res.status).toBe(403);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("database_archived");
    });
  });

  describe("query database (issue #157)", () => {
    it("rejects an unauthenticated request", async () => {
      const res = await fetch(`${baseUrl}/api/databases/${randomUUID()}/query`, { method: "POST" });
      expect(res.status).toBe(401);
    });

    it("returns 404 querying an unknown database", async () => {
      const headers = await authHeader();
      const res = await fetch(`${baseUrl}/api/databases/${randomUUID()}/query`, { method: "POST", headers });
      expect(res.status).toBe(404);
    });

    it("returns items ordered by id by default with no body, never 204", async () => {
      const db = await makeMoviesDb();
      const a = await chokePoint.createItem({ databaseId: db.id, properties: { title: "A" } });
      const b = await chokePoint.createItem({ databaseId: db.id, properties: { title: "B" } });
      const headers = await authHeader();

      const res = await fetch(`${baseUrl}/api/databases/${db.id}/query`, { method: "POST", headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ItemQueryBody;
      expect(body.items.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());
    });

    it("applies a filter tree", async () => {
      const db = await makeMoviesDb();
      await chokePoint.createItem({ databaseId: db.id, properties: { title: "Arrival" } });
      const dune = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const res = await fetch(`${baseUrl}/api/databases/${db.id}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ filter: { type: "equals", property: "title", value: "Dune" } }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ItemQueryBody;
      expect(body.items.map((i) => i.id)).toEqual([dune.id]);
    });

    it("excludes soft-deleted items by default and includes them with inTrash: true", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      await chokePoint.softDeleteItem(db.id, item.id);
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const liveRes = await fetch(`${baseUrl}/api/databases/${db.id}/query`, { method: "POST", headers, body: "{}" });
      const liveBody = (await liveRes.json()) as ItemQueryBody;
      expect(liveBody.items).toEqual([]);

      const trashRes = await fetch(`${baseUrl}/api/databases/${db.id}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ inTrash: true }),
      });
      const trashBody = (await trashRes.json()) as ItemQueryBody;
      expect(trashBody.items.map((i) => i.id)).toEqual([item.id]);
    });

    it("paginates with a stable, non-duplicating keyset cursor under default order", async () => {
      const db = await makeMoviesDb();
      const items = [];
      for (let i = 0; i < 5; i++) {
        items.push(await chokePoint.createItem({ databaseId: db.id, properties: { title: `T${i}` } }));
      }
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const sortedIds = [...items.map((i) => i.id)].sort();

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page++) {
        const res = await fetch(`${baseUrl}/api/databases/${db.id}/query`, {
          method: "POST",
          headers,
          body: JSON.stringify({ limit: 2, cursor: cursor ?? undefined }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as ItemQueryBody;
        seen.push(...body.items.map((i) => i.id));
        cursor = body.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toEqual(sortedIds);
      expect(new Set(seen).size).toBe(sortedIds.length);
    });

    it("returns validation_failed for a malformed filter tree, with no partial results", async () => {
      const db = await makeMoviesDb();
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const res = await fetch(`${baseUrl}/api/databases/${db.id}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ filter: { type: "not_a_real_type", property: "title" } }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("validation_failed");
    });

    it("returns validation_failed for a malformed sort array", async () => {
      const db = await makeMoviesDb();
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const res = await fetch(`${baseUrl}/api/databases/${db.id}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ sort: [{ property: "title", direction: "sideways" }] }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("validation_failed");
    });

    it("returns validation_failed for a non-positive limit", async () => {
      const db = await makeMoviesDb();
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const res = await fetch(`${baseUrl}/api/databases/${db.id}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ limit: 0 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("validation_failed");
    });

    it("returns validation_failed for a non-UUID cursor used for keyset paging", async () => {
      const db = await makeMoviesDb();
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const res = await fetch(`${baseUrl}/api/databases/${db.id}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ cursor: "not-a-uuid" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("validation_failed");
    });

    it("returns validation_failed for a non-boolean inTrash", async () => {
      const db = await makeMoviesDb();
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const res = await fetch(`${baseUrl}/api/databases/${db.id}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ inTrash: "yes" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("validation_failed");
    });

    it("matches an equivalent stored view's query results for the same database", async () => {
      const db = await makeMoviesDb();
      const arrival = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Arrival" } });
      await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const filter = { type: "equals", property: "title", value: "Arrival" };

      const view = await chokePoint.createView({
        databaseId: db.id,
        type: "table",
        name: "Arrivals",
        config: { filter },
      });

      const dbRes = await fetch(`${baseUrl}/api/databases/${db.id}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ filter }),
      });
      const dbBody = (await dbRes.json()) as ItemQueryBody;

      const viewRes = await fetch(`${baseUrl}/api/views/${view.id}/query`, { method: "POST", headers, body: "{}" });
      const viewBody = (await viewRes.json()) as ItemQueryBody;

      expect(dbBody.items.map((i) => i.id)).toEqual([arrival.id]);
      expect(viewBody.items.map((i) => i.id)).toEqual(dbBody.items.map((i) => i.id));
      expect(viewBody.nextCursor).toBe(dbBody.nextCursor);
    });
  });

  describe("query totalCount (includeCount)", () => {
    it("returns the same totalCount from the database and a view over it, and none by default", async () => {
      const db = await makeMoviesDb();
      for (const title of ["Arrival", "Arrival", "Arrival", "Dune"]) {
        await chokePoint.createItem({ databaseId: db.id, properties: { title } });
      }
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const filter = { type: "equals", property: "title", value: "Arrival" };
      const view = await chokePoint.createView({ databaseId: db.id, type: "table", name: "A", config: { filter } });

      const dbRes = await fetch(`${baseUrl}/api/databases/${db.id}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ filter, limit: 2, includeCount: true }),
      });
      const dbBody = (await dbRes.json()) as ItemQueryBody;
      const viewRes = await fetch(`${baseUrl}/api/views/${view.id}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ limit: 2, includeCount: true }),
      });
      const viewBody = (await viewRes.json()) as ItemQueryBody;
      expect(dbBody.items).toHaveLength(2);
      expect(dbBody.totalCount).toBe(3);
      expect(viewBody.totalCount).toBe(3);

      const plain = await fetch(`${baseUrl}/api/databases/${db.id}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ filter }),
      });
      expect(await plain.json()).not.toHaveProperty("totalCount");
    });

    it("returns 400 naming includeCount for a non-boolean value on both routes", async () => {
      const db = await makeMoviesDb();
      const view = await chokePoint.createView({ databaseId: db.id, type: "table", name: "V" });
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      for (const url of [`${baseUrl}/api/databases/${db.id}/query`, `${baseUrl}/api/views/${view.id}/query`]) {
        const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ includeCount: "yes" }) });
        expect(res.status).toBe(400);
        const body = (await res.json()) as ErrorBody;
        expect(JSON.stringify(body.error)).toContain("includeCount");
      }
    });
  });

  describe("count items (issue #1709)", () => {
    /** The whole body of a successful count. */
    const countsBody = z
      .object({
        counts: z.array(
          z
            .object({
              databaseId: z.string(),
              count: z.number(),
              groups: z.array(z.object({ key: z.string().nullable(), count: z.number() }).strict()).optional(),
            })
            .strict(),
        ),
      })
      .strict();

    async function postCount(headers: Record<string, string>, body: unknown): Promise<Response> {
      return fetch(`${baseUrl}/api/items/count`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("rejects an unauthenticated request", async () => {
      const res = await fetch(`${baseUrl}/api/items/count`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ databaseId: randomUUID() }] }),
      });
      expect(res.status).toBe(401);
    });

    it("returns the counts in request order, with a filter applied and groups in option order", async () => {
      const db = await chokePoint.createDatabase({ name: "Board" });
      await chokePoint.createProperty({ databaseId: db.id, key: "title", name: "Title", type: "text" });
      await chokePoint.createProperty({
        databaseId: db.id,
        key: "stage",
        name: "Stage",
        type: "select",
        config: { options: [{ key: "todo" }, { key: "doing" }, { key: "done" }] },
      });
      const other = await makeMoviesDb();
      for (const [title, stage] of [
        ["A", "done"],
        ["B", "todo"],
        ["C", "done"],
        ["D", undefined],
      ] as const) {
        await chokePoint.createItem({
          databaseId: db.id,
          properties: { title, ...(stage === undefined ? {} : { stage }) },
        });
      }
      await chokePoint.createItem({ databaseId: other.id, properties: { title: "Dune" } });

      const res = await postCount(await authHeader(), {
        items: [
          { databaseId: other.id },
          { databaseId: db.id, groupBy: "stage" },
          { databaseId: db.id, filter: { type: "not_equals", property: "title", value: "A" }, groupBy: "stage" },
        ],
      });

      expect(res.status).toBe(200);
      expect(countsBody.parse(await res.json())).toEqual({
        counts: [
          { databaseId: other.id, count: 1 },
          {
            databaseId: db.id,
            count: 4,
            groups: [
              { key: "todo", count: 1 },
              { key: "done", count: 2 },
              { key: null, count: 1 },
            ],
          },
          {
            databaseId: db.id,
            count: 3,
            groups: [
              { key: "todo", count: 1 },
              { key: "done", count: 1 },
              { key: null, count: 1 },
            ],
          },
        ],
      });
    });

    it("applies the collection filter the module registry declares, through the real composition root", async () => {
      await seedSystem(pool, createViewTypeRegistry());
      const projects = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects"));
      if (!projects) throw new Error("Projects database was not seeded");
      const everyProject = async () => (await chokePoint.listItems(projects.id, { limit: 200 })).items.length;
      const systemProjects = await everyProject();
      expect(systemProjects).toBeGreaterThan(0);
      await chokePoint.createItem({ databaseId: projects.id, properties: { name: "Garden" } });

      const res = await postCount(await authHeader(), {
        items: [{ databaseId: projects.id }, { databaseId: projects.id, collection: true }],
      });

      expect(res.status).toBe(200);
      expect(countsBody.parse(await res.json())).toEqual({
        counts: [
          { databaseId: projects.id, count: systemProjects + 1 },
          { databaseId: projects.id, count: 1 },
        ],
      });
    });

    it("returns 400 for more than 20 entries, and for none", async () => {
      const db = await makeMoviesDb();
      const headers = await authHeader();
      for (const length of [21, 0]) {
        const res = await postCount(headers, { items: Array.from({ length }, () => ({ databaseId: db.id })) });
        expect(res.status, String(length)).toBe(400);
        expect(httpError.parse(await res.json()).error).toEqual({
          code: "validation_failed",
          details: { field: "items" },
        });
      }
      const allowed = await postCount(headers, { items: Array.from({ length: 20 }, () => ({ databaseId: db.id })) });
      expect(allowed.status).toBe(200);
      expect(countsBody.parse(await allowed.json()).counts).toHaveLength(20);
    });

    it("returns 400 naming groupBy for a property that cannot group, and for an unknown key", async () => {
      const db = await makeMoviesDb();
      const headers = await authHeader();
      for (const groupBy of ["title", "missing"]) {
        const res = await postCount(headers, { items: [{ databaseId: db.id, groupBy }] });
        expect(res.status, groupBy).toBe(400);
        expect(httpError.parse(await res.json()).error).toEqual({
          code: "validation_failed",
          details: { field: "groupBy" },
        });
      }
    });

    it.each([
      ["a missing items list", {}, "items"],
      ["an unknown body key", { items: [], inTrash: true }, "inTrash"],
      ["a malformed database id", { items: [{ databaseId: "not-a-uuid" }] }, "items.0.databaseId"],
      ["an unknown entry key", { items: [{ databaseId: randomUUID(), inTrash: true }] }, "items.0"],
    ])("returns 400 for %s", async (_name, body, field) => {
      const res = await postCount(await authHeader(), body);
      expect(res.status).toBe(400);
      expect(httpError.parse(await res.json()).error).toEqual({ code: "validation_failed", details: { field } });
    });

    it("refuses a malformed entry filter with the answer the database query gives for it", async () => {
      const db = await makeMoviesDb();
      const headers = await authHeader();
      for (const filter of [{ type: "nope" }, { type: "relation_path_contains", path: ["only"], value: "x" }]) {
        const query = await fetch(`${baseUrl}/api/databases/${db.id}/query`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ filter }),
        });
        expect(query.status).toBe(400);
        const queryAnswer: unknown = await query.json();
        const res = await postCount(headers, { items: [{ databaseId: db.id, filter }] });
        expect(res.status).toBe(400);
        const answer: unknown = await res.json();
        expect(answer, JSON.stringify(filter)).toEqual(queryAnswer);
      }
    });

    it("returns 400 for a body that is not a JSON object", async () => {
      const res = await postCount(await authHeader(), [{ databaseId: randomUUID() }]);
      expect(res.status).toBe(400);
      expect(z.object({ error: z.object({ code: z.string() }) }).parse(await res.json()).error.code).toBe(
        "validation_failed",
      );
    });

    it("answers an unknown database exactly as the database query does, wherever it is in the batch", async () => {
      const db = await makeMoviesDb();
      const headers = await authHeader();
      const unknown = randomUUID();
      const query = await fetch(`${baseUrl}/api/databases/${unknown}/query`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: "{}",
      });
      expect(query.status).toBe(404);
      const queryAnswer: unknown = await query.json();
      expect(queryAnswer).toEqual({
        error: { code: "not_found", details: { resource: "database", databaseId: unknown } },
      });

      for (const items of [[{ databaseId: unknown }], [{ databaseId: db.id }, { databaseId: unknown }]]) {
        const res = await postCount(headers, { items });
        expect(res.status).toBe(404);
        const answer: unknown = await res.json();
        expect(answer).toEqual(queryAnswer);
      }
    });
  });

  describe("database facets (issue #1759)", () => {
    /** The whole body of a successful facets read. */
    const facetsBody = z
      .object({
        facets: z.array(
          z
            .object({
              property: z.string().optional(),
              path: z.tuple([z.string(), z.string()]).optional(),
              all: z.number(),
              open: z.number().optional(),
              values: z.array(
                z
                  .object({
                    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
                    label: z.string().optional(),
                    color: z.string().optional(),
                    count: z.number(),
                  })
                  .strict(),
              ),
            })
            .strict(),
        ),
      })
      .strict();

    async function postFacets(headers: Record<string, string>, databaseId: string, body: unknown): Promise<Response> {
      return fetch(`${baseUrl}/api/databases/${databaseId}/facets`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    /** A session of a new user whose `users.locale` is `locale`. */
    async function authHeaderIn(locale: string): Promise<{ Authorization: string }> {
      const user = await createUser(pool, {
        tenantId: await tenantForNextTestUser(pool),
        email: `${randomUUID()}@example.com`,
        passwordHash: await hashPassword(PASSWORD),
        locale,
      });
      const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
      return { Authorization: `Bearer ${token}` };
    }

    async function seededDatabase(key: string) {
      const database = await withTransaction(pool, (client) => getDatabaseByModuleId(client, key));
      if (!database) throw new Error(`The '${key}' database was not seeded`);
      return database;
    }

    /** A board with a text, a select that is not status-like and a checkbox, and four cards. */
    async function makeBoard() {
      const db = await chokePoint.createDatabase({ name: "Board" });
      await chokePoint.createProperty({ databaseId: db.id, key: "title", name: "Title", type: "text" });
      await chokePoint.createProperty({
        databaseId: db.id,
        key: "stage",
        name: "Stage",
        type: "select",
        config: { options: [{ key: "todo", label: "To do", color: "#FF9500" }, { key: "doing" }, { key: "done" }] },
      });
      await chokePoint.createProperty({ databaseId: db.id, key: "urgent", name: "Urgent", type: "checkbox" });
      for (const properties of [
        { title: "A", stage: "done", urgent: true },
        { title: "B", stage: "todo", urgent: true },
        { title: "C", stage: "done" },
        { title: "D" },
      ]) {
        await chokePoint.createItem({ databaseId: db.id, properties });
      }
      return db;
    }

    it("rejects an unauthenticated request", async () => {
      const res = await fetch(`${baseUrl}/api/databases/${randomUUID()}/facets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ facets: ["status"] }),
      });
      expect(res.status).toBe(401);
    });

    it("returns the facets in request order, each under the filter without its own conditions, with the open count", async () => {
      const db = await makeBoard();

      const res = await postFacets(await authHeader(), db.id, {
        filter: {
          type: "and",
          nodes: [
            { type: "equals", property: "stage", value: "done" },
            { type: "equals", property: "urgent", value: true },
          ],
        },
        facets: ["stage", "urgent", "title"],
        extra: { open: { type: "equals", property: "title", value: "A" } },
      });

      expect(res.status).toBe(200);
      expect(facetsBody.parse(await res.json())).toEqual({
        facets: [
          // The urgent cards, whatever their stage: A (done) and B (to do).
          {
            property: "stage",
            all: 2,
            open: 1,
            values: [
              { value: "todo", label: "To do", color: "#FF9500", count: 1 },
              { value: "done", label: "done", count: 1 },
              { value: null, count: 0 },
            ],
          },
          // The done cards, urgent or not: A and C.
          {
            property: "urgent",
            all: 2,
            open: 1,
            values: [
              { value: true, count: 1 },
              { value: false, count: 1 },
            ],
          },
          // Both conditions stay for the title: A alone.
          { property: "title", all: 1, open: 1, values: [{ value: "A", count: 1 }] },
        ],
      });
    });

    it("lists every status of Projects inside an area in the user's language, and every area for the area facet, through the real composition root", async () => {
      await seedSystem(pool, createViewTypeRegistry());
      const projects = await seededDatabase("projects");
      const areas = await seededDatabase("areas");
      const [seededArea] = (await chokePoint.listItems(areas.id, { limit: 200 })).items;
      if (!seededArea) throw new Error("The seeded area is missing");
      const work = await chokePoint.createItem({
        databaseId: areas.id,
        properties: { name: "Work", color: "#007AFF" },
      });
      const home = await chokePoint.createItem({ databaseId: areas.id, properties: { name: "Home" } });
      const areaProperty = (await chokePoint.listProperties(projects.id)).find((property) => property.key === "area");
      if (!areaProperty) throw new Error("The Projects area relation is missing");
      for (const [name, status, area] of [
        ["Launch", "inProgress", work],
        ["Audit", "done", work],
        ["Garden", "inProgress", home],
      ] as const) {
        const project = await chokePoint.createItem({ databaseId: projects.id, properties: { name, status } });
        await chokePoint.createRelation({
          relationPropertyId: areaProperty.id,
          callerItemId: project.id,
          targetItemId: area.id,
        });
      }
      const inProgress = { type: "equals", property: "status", value: "inProgress" };

      // A new user's `users.locale` is `cs`.
      const res = await postFacets(await authHeader(), projects.id, {
        filter: {
          type: "and",
          nodes: [
            { type: "is_empty", property: "systemActive" },
            inProgress,
            { type: "relation_contains", property: "area", value: work.id },
          ],
        },
        facets: ["status", "area"],
        extra: { open: inProgress },
      });

      expect(res.status).toBe(200);
      const [workFirst, homeSecond] = work.id < home.id ? [work, home] : [home, work];
      const areaChoice = (area: typeof work) => ({
        value: area.id,
        label: String(area.properties.name),
        ...(area.id === work.id ? { color: "#007AFF" } : {}),
        count: 1,
      });
      expect(facetsBody.parse(await res.json())).toEqual({
        facets: [
          {
            property: "status",
            all: 2,
            open: 1,
            values: [
              { value: "inProgress", label: "Probíhá", color: "#007AFF", count: 1 },
              { value: "longTerm", label: "Dlouhodobé", color: "#AF52DE", count: 0 },
              { value: "done", label: "Hotovo", color: "#34C759", count: 1 },
              { value: "archived", label: "Archivováno", color: "#8E8E93", count: 0 },
              { value: null, count: 0 },
            ],
          },
          {
            property: "area",
            all: 2,
            open: 2,
            values: [
              areaChoice(workFirst),
              areaChoice(homeSecond),
              { value: seededArea.id, label: String(seededArea.properties.name), count: 0 },
              { value: null, count: 0 },
            ],
          },
        ],
      });
    });

    it("labels the options in English for a user whose locale is en", async () => {
      await seedSystem(pool, createViewTypeRegistry());
      const projects = await seededDatabase("projects");

      const res = await postFacets(await authHeaderIn("en"), projects.id, {
        filter: { type: "is_empty", property: "systemActive" },
        facets: ["status"],
      });

      expect(res.status).toBe(200);
      const [status] = facetsBody.parse(await res.json()).facets;
      expect(status?.values.map((choice) => choice.label)).toEqual([
        "In progress",
        "Long-term",
        "Done",
        "Archived",
        undefined,
      ]);
    });

    it("returns 400 naming filter for a condition on the facet itself under or and under not, and reads the same filter for another facet", async () => {
      const db = await makeBoard();
      const headers = await authHeader();
      const done = { type: "equals", property: "stage", value: "done" };
      const urgent = { type: "equals", property: "urgent", value: true };
      for (const filter of [
        { type: "or", nodes: [done, urgent] },
        { type: "not", node: done },
      ]) {
        const res = await postFacets(headers, db.id, { filter, facets: ["title", "stage"] });
        expect(res.status, filter.type).toBe(400);
        expect(httpError.parse(await res.json()).error).toEqual({
          code: "validation_failed",
          details: { field: "filter" },
        });
        const other = await postFacets(headers, db.id, { filter, facets: ["title"] });
        expect(other.status, filter.type).toBe(200);
      }
    });

    it("returns 400 for more than 20 facets, and for none", async () => {
      const db = await makeBoard();
      const headers = await authHeader();
      for (const length of [21, 0]) {
        const res = await postFacets(headers, db.id, { facets: Array.from({ length }, () => "stage") });
        expect(res.status, String(length)).toBe(400);
        expect(httpError.parse(await res.json()).error).toEqual({
          code: "validation_failed",
          details: { field: "facets" },
        });
      }
      const allowed = await postFacets(headers, db.id, { facets: Array.from({ length: 20 }, () => "stage") });
      expect(allowed.status).toBe(200);
      expect(facetsBody.parse(await allowed.json()).facets).toHaveLength(20);
    });

    it("returns 400 naming facets for an unknown key, a property that cannot be a facet and an unresolvable path", async () => {
      const db = await makeBoard();
      await chokePoint.createProperty({ databaseId: db.id, key: "note", name: "Note", type: "longText" });
      const headers = await authHeader();
      for (const facet of ["missing", "note", { path: ["stage", "title"] }]) {
        const res = await postFacets(headers, db.id, { facets: [facet] });
        expect(res.status, JSON.stringify(facet)).toBe(400);
        expect(httpError.parse(await res.json()).error).toEqual({
          code: "validation_failed",
          details: { field: "facets" },
        });
      }
    });

    it.each([
      ["a missing facet list", {}, "facets"],
      ["an unknown body key", { facets: ["stage"], q: "text" }, "q"],
      ["a database id in the body", { facets: ["stage"], databaseId: randomUUID() }, "databaseId"],
      ["an empty facet key", { facets: ["stage", ""] }, "facets.1"],
      [
        "an extra with another key",
        { facets: ["stage"], extra: { open: { type: "is_empty", property: "title" }, top: 5 } },
        "extra",
      ],
    ])("returns 400 for %s", async (_name, body, field) => {
      const db = await makeBoard();
      const res = await postFacets(await authHeader(), db.id, body);
      expect(res.status).toBe(400);
      expect(httpError.parse(await res.json()).error).toEqual({ code: "validation_failed", details: { field } });
    });

    it("refuses a malformed filter, in filter and in extra.open, with the answer the database query gives for it", async () => {
      const db = await makeBoard();
      const headers = await authHeader();
      for (const filter of [{ type: "nope" }, { type: "relation_path_contains", path: ["only"], value: "x" }]) {
        const query = await fetch(`${baseUrl}/api/databases/${db.id}/query`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ filter }),
        });
        expect(query.status).toBe(400);
        const queryAnswer: unknown = await query.json();
        for (const body of [
          { facets: ["stage"], filter },
          { facets: ["stage"], extra: { open: filter } },
        ]) {
          const res = await postFacets(headers, db.id, body);
          expect(res.status).toBe(400);
          const answer: unknown = await res.json();
          expect(answer, JSON.stringify(body)).toEqual(queryAnswer);
        }
      }
    });

    it("returns 400 for a body that is not a JSON object, and for a database id that is not a UUID as the database query does", async () => {
      const db = await makeBoard();
      const headers = await authHeader();
      const list = await postFacets(headers, db.id, ["stage"]);
      expect(list.status).toBe(400);
      expect(z.object({ error: z.object({ code: z.string() }) }).parse(await list.json()).error.code).toBe(
        "validation_failed",
      );

      const query = await fetch(`${baseUrl}/api/databases/not-a-uuid/query`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: "{}",
      });
      expect(query.status).toBe(400);
      const queryAnswer: unknown = await query.json();
      const res = await postFacets(headers, "not-a-uuid", { facets: ["stage"] });
      expect(res.status).toBe(400);
      const answer: unknown = await res.json();
      expect(answer).toEqual(queryAnswer);
    });

    it("answers an unknown database exactly as the database query does", async () => {
      const headers = await authHeader();
      const unknown = randomUUID();
      const query = await fetch(`${baseUrl}/api/databases/${unknown}/query`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: "{}",
      });
      expect(query.status).toBe(404);
      const queryAnswer: unknown = await query.json();
      expect(queryAnswer).toEqual({
        error: { code: "not_found", details: { resource: "database", databaseId: unknown } },
      });

      for (const body of [
        { facets: ["stage"] },
        { facets: [{ path: ["project", "area"] }], extra: { open: { type: "is_empty", property: "title" } } },
      ]) {
        const res = await postFacets(headers, unknown, body);
        expect(res.status).toBe(404);
        const answer: unknown = await res.json();
        expect(answer).toEqual(queryAnswer);
      }
    });
  });

  describe("include=links (issue #1403)", () => {
    /** A file linked to a task, as the later propagation issue (#1593) will leave it; written through the store because nothing in product code writes links yet. */
    async function makeLinkedFile(options: { extraSource?: boolean; broken?: boolean } = {}) {
      const tasksDb = await chokePoint.createDatabase({ name: "Tasks", ownerModuleId: "linksTasks", system: true });
      await chokePoint.createProperty({ databaseId: tasksDb.id, key: "title", name: "Title", type: "title" });
      const filesDb = await chokePoint.createDatabase({ name: "Files" });
      const task = await chokePoint.createItem({ databaseId: tasksDb.id, properties: { title: "Send the invoice" } });
      const other = await chokePoint.createItem({ databaseId: tasksDb.id, properties: { title: "Pay the invoice" } });
      const file = await chokePoint.createItem({ databaseId: filesDb.id, properties: {} });
      const plain = await chokePoint.createItem({ databaseId: filesDb.id, properties: {} });
      await withTransaction(pool, (client) =>
        insertValueLink(client, {
          itemId: file.id,
          propertyKey: "projects",
          ruleKey: "fileProject",
          ...(options.broken
            ? { state: "broken" as const, brokenBy: "user" as const, brokenAt: new Date("2026-10-20T10:00:00.000Z") }
            : {}),
          sources: [
            { kind: "item", sourceItemId: task.id, sourcePropertyKey: "project" },
            ...(options.extraSource
              ? [{ kind: "item" as const, sourceItemId: other.id, sourcePropertyKey: "project" }]
              : []),
          ],
        }),
      );
      return { tasksDb, filesDb, task, other, file, plain };
    }

    it("breaks a linked plain value through a user REST patch", async () => {
      const { filesDb, file } = await makeLinkedFile();
      await chokePoint.createProperty({ databaseId: filesDb.id, key: "note", name: "Note", type: "text" });
      await withTransaction(pool, (client) =>
        insertValueLink(client, {
          itemId: file.id,
          propertyKey: "note",
          ruleKey: "test",
          sources: [],
        }),
      );
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const response = await fetch(`${baseUrl}/api/items/${file.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties: { note: "changed" }, ifVersion: file.updatedAt }),
      });
      expect(response.status).toBe(200);
      const read = await fetch(`${baseUrl}/api/items/${file.id}?include=links`, { headers });
      expect(read.status).toBe(200);
      const body: unknown = await read.json();
      expect(body).toMatchObject({
        properties: { note: "changed" },
        links: { note: { valueKind: "inheritedBroken", brokenBy: "user" } },
      });
    });

    it("returns links.projects with the inherited kind and the source including its title", async () => {
      const { file, task } = await makeLinkedFile();
      const headers = await authHeader();

      const res = await fetch(`${baseUrl}/api/items/${file.id}?include=links`, { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ItemBody;
      expect(body.links).toEqual({
        projects: {
          valueKind: "inherited",
          sources: [
            {
              kind: "item",
              itemId: task.id,
              databaseKey: "linksTasks",
              title: "Send the invoice",
              propertyKey: "project",
            },
          ],
          brokenBy: null,
          brokenAt: null,
        },
      });
    });

    it("returns both sources of a link with two sources", async () => {
      const { file } = await makeLinkedFile({ extraSource: true });
      const headers = await authHeader();

      const body = (await (
        await fetch(`${baseUrl}/api/items/${file.id}?include=links`, { headers })
      ).json()) as ItemBody;
      const entry = body.links?.projects as { sources: { title: string }[] };
      expect(entry.sources.map((source) => source.title).sort()).toEqual(["Pay the invoice", "Send the invoice"]);
    });

    it("reads a broken row as inheritedBroken with brokenBy and brokenAt", async () => {
      const { file } = await makeLinkedFile({ broken: true });
      const headers = await authHeader();

      const body = (await (
        await fetch(`${baseUrl}/api/items/${file.id}?include=links`, { headers })
      ).json()) as ItemBody;
      expect(body.links?.projects).toMatchObject({
        valueKind: "inheritedBroken",
        brokenBy: "user",
        brokenAt: "2026-10-20T10:00:00.000Z",
      });
    });

    it("returns an empty links object for an item without a row, and no links field without include", async () => {
      const { plain, file } = await makeLinkedFile();
      const headers = await authHeader();

      const withLinks = (await (
        await fetch(`${baseUrl}/api/items/${plain.id}?include=links`, { headers })
      ).json()) as ItemBody;
      expect(withLinks.links).toEqual({});
      const without = (await (await fetch(`${baseUrl}/api/items/${file.id}`, { headers })).json()) as ItemBody;
      expect("links" in without).toBe(false);
    });

    it("returns both the path and the links for include=path,links, and only the path for include=path", async () => {
      const { file } = await makeLinkedFile();
      const headers = await authHeader();

      const both = (await (
        await fetch(`${baseUrl}/api/items/${file.id}?include=path,links`, { headers })
      ).json()) as ItemBody;
      expect(both.path?.map((item) => item.id)).toEqual([file.id]);
      expect(Object.keys(both.links ?? {})).toEqual(["projects"]);
      const pathOnly = (await (
        await fetch(`${baseUrl}/api/items/${file.id}?include=path`, { headers })
      ).json()) as ItemBody;
      expect(pathOnly.path).toHaveLength(1);
      expect("links" in pathOnly).toBe(false);
    });

    it("returns 404 for an unknown item with include=path,links", async () => {
      const headers = await authHeader();
      const res = await fetch(`${baseUrl}/api/items/${randomUUID()}?include=path,links`, { headers });
      expect(res.status).toBe(404);
    });

    it("gives each item of a database.query page its own links, and none without include", async () => {
      const { filesDb, file, plain } = await makeLinkedFile();
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const res = await fetch(`${baseUrl}/api/databases/${filesDb.id}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ include: ["links"] }),
      });
      expect(res.status).toBe(200);
      const page = (await res.json()) as ItemQueryBody;
      const byId = new Map(page.items.map((item) => [item.id, item]));
      expect(Object.keys(byId.get(file.id)?.links ?? {})).toEqual(["projects"]);
      expect(byId.get(plain.id)?.links).toEqual({});

      const plainRes = await fetch(`${baseUrl}/api/databases/${filesDb.id}/query`, {
        method: "POST",
        headers,
        body: "{}",
      });
      const plainPage = (await plainRes.json()) as ItemQueryBody;
      expect(plainPage.items.every((item) => !("links" in item))).toBe(true);
    });

    it("gives each item of a view.query page its own links", async () => {
      const { filesDb, file, plain } = await makeLinkedFile();
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const view = await chokePoint.createView({
        databaseId: filesDb.id,
        type: "table",
        name: "All files",
        config: {},
      });

      const res = await fetch(`${baseUrl}/api/views/${view.id}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ include: ["links"] }),
      });
      expect(res.status).toBe(200);
      const page = (await res.json()) as ItemQueryBody;
      const byId = new Map(page.items.map((item) => [item.id, item]));
      expect(Object.keys(byId.get(file.id)?.links ?? {})).toEqual(["projects"]);
      expect(byId.get(plain.id)?.links).toEqual({});
    });

    it("returns the production fileCompaniesFromProjects link with both project sources through runtime HTTP, and nothing to another tenant (issue #1653)", async () => {
      await seedSystem(pool, createViewTypeRegistry());
      const headers = await authHeader();
      const foreignHeaders = await authHeader();
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      let runtimeServer: Server | undefined;
      const failures: unknown[] = [];
      try {
        const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        );
        expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
        const dispatch = await createDispatcher(runtime, {
          passwordResetMailer: noopMailer,
          appBaseUrl: "http://localhost",
          setupToken: "unused-setup-token",
          moduleRegistry,
          blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
          maxFileSizeBytes: 10 * 1024 * 1024,
        });
        runtimeServer = createServer(dispatch);
        const ownedServer = runtimeServer;
        await new Promise<void>((resolve, reject) => {
          ownedServer.once("error", reject);
          ownedServer.listen(0, "127.0.0.1", resolve);
        });
        const address = runtimeServer.address();
        if (!address || typeof address === "string") throw new Error("Expected runtime server");
        const base = `http://127.0.0.1:${address.port}`;
        // Real writes in the reader's tenant through the choke point; the link comes from the manifest's rule.
        const fixture = await runInTenant(getTenantZeroId(), async () => {
          const cp = createChokePoint(runtime);
          const databases = await cp.listDatabases();
          const db = (key: string) => {
            const match = databases.find((entry) => entry.ownerModuleId === key);
            if (!match) throw new Error(`Missing ${key}`);
            return match.id;
          };
          const relation = async (databaseKey: string, key: string) => {
            const match = (await cp.listProperties(db(databaseKey))).find((property) => property.key === key);
            if (!match) throw new Error(`Missing ${databaseKey}.${key}`);
            return match.id;
          };
          const create = async (databaseKey: string, name: string) =>
            (await cp.createItem({ databaseId: db(databaseKey), properties: { name } })).id;
          const user = { writerKind: "user" } as const;
          const novak = await create("companies", "Novak Web s.r.o.");
          const siko = await create("companies", "Siko Koupelny a.s.");
          const web = await create("projects", "Web for client");
          const bathroom = await create("projects", "Bathroom renovation");
          const file = await create("files", "Contract");
          const projectCompany = await relation("projects", "company");
          const fileProjects = await relation("files", "projects");
          await cp.createRelation({ relationPropertyId: projectCompany, callerItemId: web, targetItemId: novak }, user);
          await cp.createRelation(
            { relationPropertyId: projectCompany, callerItemId: bathroom, targetItemId: siko },
            user,
          );
          await cp.createRelation({ relationPropertyId: fileProjects, callerItemId: file, targetItemId: web }, user);
          await cp.createRelation(
            { relationPropertyId: fileProjects, callerItemId: file, targetItemId: bathroom },
            user,
          );
          return { novak, siko, web, bathroom, file };
        });
        const byItem = (a: { itemId: string }, b: { itemId: string }) => a.itemId.localeCompare(b.itemId);

        const read = await fetch(`${base}/api/items/${fixture.file}?include=links`, { headers });
        expect(read.status).toBe(200);
        const companies = itemLinkEntry.parse(linkedItemBody.parse(await read.json()).links.companies);
        expect({ ...companies, sources: [...companies.sources].sort(byItem) }).toEqual({
          valueKind: "inherited",
          sources: [
            {
              kind: "item",
              itemId: fixture.web,
              databaseKey: "projects",
              title: "Web for client",
              propertyKey: "company",
            },
            {
              kind: "item",
              itemId: fixture.bathroom,
              databaseKey: "projects",
              title: "Bathroom renovation",
              propertyKey: "company",
            },
          ].sort(byItem),
          brokenBy: null,
          brokenAt: null,
        });
        const listed = await fetch(`${base}/api/items/${fixture.file}/relations?propertyKey=companies`, { headers });
        expect(listed.status).toBe(200);
        const targets = relationTargets.parse(await listed.json()).relations.map((entry) => entry.targetItemId);
        expect(targets.sort()).toEqual([fixture.novak, fixture.siko].sort());

        const foreign = await fetch(`${base}/api/items/${fixture.file}?include=links`, { headers: foreignHeaders });
        const randomId = randomUUID();
        const random = await fetch(`${base}/api/items/${randomId}?include=links`, { headers: foreignHeaders });
        expect(foreign.status).toBe(404);
        expect(random.status).toBe(404);
        expect((await foreign.text()).replaceAll(fixture.file, "<id>")).toEqual(
          (await random.text()).replaceAll(randomId, "<id>"),
        );
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          if (runtimeServer)
            await new Promise<void>((resolve, reject) =>
              runtimeServer?.close((error) => (error ? reject(error) : resolve())),
            );
        } catch (error) {
          failures.push(error);
        }
        try {
          await runtime.end();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "REST test and settlement failed");
    });

    it("rejects an include value the catalog does not know", async () => {
      const db = await makeMoviesDb();
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const res = await fetch(`${baseUrl}/api/databases/${db.id}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ include: ["comments"] }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("relations (issue #157)", () => {
    async function makePairedRelation(cardinality?: "one_to_one" | "one_to_many" | "many_to_many") {
      const source = await chokePoint.createDatabase({ name: "Tasks" });
      const target = await chokePoint.createDatabase({ name: "People" });
      const { property } = await chokePoint.createRelationProperty({
        sourceDatabaseId: source.id,
        key: "assignedTo",
        name: "Assigned To",
        targetDatabaseId: target.id,
        cardinality,
        inverse: { key: "assignedTasks", name: "Assigned Tasks" },
      });
      const inverseProperty = await chokePoint.getPropertyByKey(target.id, "assignedTasks");
      if (!inverseProperty) throw new Error("expected inverse property to exist");
      return { source, target, property, inverseProperty };
    }

    describe("PUT create/replace", () => {
      it("rejects an unauthenticated request", async () => {
        const res = await fetch(`${baseUrl}/api/items/${randomUUID()}/relations/foo/${randomUUID()}`, {
          method: "PUT",
        });
        expect(res.status).toBe(401);
      });

      it("returns 404 for an unknown caller item", async () => {
        const headers = await authHeader();
        const res = await fetch(`${baseUrl}/api/items/${randomUUID()}/relations/foo/${randomUUID()}`, {
          method: "PUT",
          headers,
        });
        expect(res.status).toBe(404);
      });

      it("returns 400 validation_failed naming 'targetItemId' for a non-UUID target item id", async () => {
        const headers = await authHeader();
        const res = await fetch(`${baseUrl}/api/items/${randomUUID()}/relations/exampleKey/foo`, {
          method: "PUT",
          headers,
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as ErrorBody;
        expect(body.error.code).toBe("validation_failed");
        expect(body.error.details).toEqual({ field: "targetItemId" });
      });

      it("returns 404 for a propertyKey that doesn't exist on the caller's database", async () => {
        const { source } = await makePairedRelation();
        const item = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const headers = await authHeader();

        const res = await fetch(`${baseUrl}/api/items/${item.id}/relations/nope/${randomUUID()}`, {
          method: "PUT",
          headers,
        });
        expect(res.status).toBe(404);
      });

      it("returns 404 for a propertyKey belonging to a foreign, unrelated database", async () => {
        const { source } = await makePairedRelation();
        const item = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const other = await chokePoint.createDatabase({ name: "Other" });
        await chokePoint.createProperty({ databaseId: other.id, key: "unrelated", name: "Unrelated", type: "text" });
        const headers = await authHeader();

        const res = await fetch(`${baseUrl}/api/items/${item.id}/relations/unrelated/${randomUUID()}`, {
          method: "PUT",
          headers,
        });
        expect(res.status).toBe(404);
      });

      it("returns 404 relationProperty for a non-relation property with that key on the caller's own database (issue #432)", async () => {
        const { source } = await makePairedRelation();
        await chokePoint.createProperty({ databaseId: source.id, key: "notes", name: "Notes", type: "text" });
        const item = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const headers = await authHeader();

        const res = await fetch(`${baseUrl}/api/items/${item.id}/relations/notes/${randomUUID()}`, {
          method: "PUT",
          headers,
        });
        expect(res.status).toBe(404);
        const body = (await res.json()) as ErrorBody;
        expect(body.error).toEqual({
          code: "not_found",
          details: { resource: "relationProperty", databaseId: source.id, propertyKey: "notes" },
        });
      });

      it("creates an edge from the direct (A) side and returns 200 with the full envelope, never 204", async () => {
        const { source, target, property } = await makePairedRelation();
        const task = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const person = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        const headers = { ...(await authHeader()), "Content-Type": "application/json" };

        const res = await fetch(`${baseUrl}/api/items/${task.id}/relations/${property.key}/${person.id}`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ metadata: { role: "owner" } }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as RelationBody;
        expect(body.itemA).toBe(task.id);
        expect(body.itemB).toBe(person.id);
        expect(body.metadata).toEqual({ role: "owner" });
      });

      it("creates an edge from the inverse (B) side, normalizing itemA/itemB the same as the A-side call", async () => {
        const { source, target, property, inverseProperty } = await makePairedRelation();
        const task = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const person = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        const headers = { ...(await authHeader()), "Content-Type": "application/json" };

        const direct = await fetch(`${baseUrl}/api/items/${task.id}/relations/${property.key}/${person.id}`, {
          method: "PUT",
          headers,
        });
        const directBody = (await direct.json()) as RelationBody;

        const inverse = await fetch(`${baseUrl}/api/items/${person.id}/relations/${inverseProperty.key}/${task.id}`, {
          method: "PUT",
          headers,
        });
        expect(inverse.status).toBe(200);
        const inverseBody = (await inverse.json()) as RelationBody;
        expect(inverseBody.id).toBe(directBody.id);
        expect(inverseBody.itemA).toBe(task.id);
        expect(inverseBody.itemB).toBe(person.id);
      });

      it("attributes a linked relation invalidation to the authenticated REST user", async () => {
        const { source, target, property } = await makePairedRelation();
        const item = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const other = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        await withTransaction(pool, (client) =>
          insertValueLink(client, {
            itemId: item.id,
            propertyKey: property.key,
            ruleKey: "test",
            sources: [],
          }),
        );
        const user = await createUser(pool, {
          tenantId: await tenantForNextTestUser(pool),
          email: `${randomUUID()}@example.com`,
          passwordHash: await hashPassword(PASSWORD),
        });
        const { token } = await login(pool, {
          email: user.email,
          password: PASSWORD,
          platform: "ios",
          ip: "127.0.0.1",
        });
        const events: InvalidationEvent[] = [];
        setInvalidationHook((event) => events.push(event));
        try {
          const response = await fetch(`${baseUrl}/api/items/${item.id}/relations/${property.key}/${other.id}`, {
            method: "PUT",
            headers: { Authorization: `Bearer ${token}` },
          });
          expect(response.status).toBe(200);
          expect(events.filter((event) => event.scope === "item" && event.itemId === item.id)).toEqual([
            expect.objectContaining({ userId: user.id }),
          ]);
        } finally {
          setInvalidationHook(() => {});
        }
      });

      it("repeating PUT with different metadata replaces rather than merges", async () => {
        const { source, target, property } = await makePairedRelation();
        const task = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const person = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        const headers = { ...(await authHeader()), "Content-Type": "application/json" };

        await fetch(`${baseUrl}/api/items/${task.id}/relations/${property.key}/${person.id}`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ metadata: { role: "owner", note: "x" } }),
        });
        const res = await fetch(`${baseUrl}/api/items/${task.id}/relations/${property.key}/${person.id}`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ metadata: { role: "reviewer" } }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as RelationBody;
        expect(body.metadata).toEqual({ role: "reviewer" });
      });

      it("enforces one_to_one cardinality with 409 cardinality_violation", async () => {
        const { source, target, property } = await makePairedRelation("one_to_one");
        const taskA = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const taskB = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const person = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        const headers = { ...(await authHeader()), "Content-Type": "application/json" };

        await fetch(`${baseUrl}/api/items/${taskA.id}/relations/${property.key}/${person.id}`, {
          method: "PUT",
          headers,
        });
        const res = await fetch(`${baseUrl}/api/items/${taskB.id}/relations/${property.key}/${person.id}`, {
          method: "PUT",
          headers,
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as ErrorBody;
        expect(body.error.code).toBe("cardinality_violation");
      });

      it("allows a single source item to relate to many targets under one_to_many", async () => {
        const { source, target, property } = await makePairedRelation("one_to_many");
        const task = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const personA = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        const personB = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        const headers = { ...(await authHeader()), "Content-Type": "application/json" };

        const resA = await fetch(`${baseUrl}/api/items/${task.id}/relations/${property.key}/${personA.id}`, {
          method: "PUT",
          headers,
        });
        const resB = await fetch(`${baseUrl}/api/items/${task.id}/relations/${property.key}/${personB.id}`, {
          method: "PUT",
          headers,
        });
        expect(resA.status).toBe(200);
        expect(resB.status).toBe(200);
      });

      it("allows both sides to relate to many under many_to_many", async () => {
        const { source, target, property } = await makePairedRelation("many_to_many");
        const taskA = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const taskB = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const person = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        const headers = { ...(await authHeader()), "Content-Type": "application/json" };

        const resA = await fetch(`${baseUrl}/api/items/${taskA.id}/relations/${property.key}/${person.id}`, {
          method: "PUT",
          headers,
        });
        const resB = await fetch(`${baseUrl}/api/items/${taskB.id}/relations/${property.key}/${person.id}`, {
          method: "PUT",
          headers,
        });
        expect(resA.status).toBe(200);
        expect(resB.status).toBe(200);
      });

      it("rejects a write through a system-owned relation property with 403 owner_violation", async () => {
        const source = await chokePoint.createDatabase({ name: "Tasks" });
        const target = await chokePoint.createDatabase({ name: "People" });
        const { property } = await chokePoint.createRelationProperty({
          sourceDatabaseId: source.id,
          key: "systemLink",
          name: "System Link",
          targetDatabaseId: target.id,
        });
        // The public facade never accepts a `SystemRelationWriteContext`, so an owner:'system'
        // property can't be created through it at all; flip it directly in the DB to set up the
        // fixture this route's rejection is being tested against.
        await pool.query("UPDATE properties SET owner = 'system', owner_process = $2 WHERE id = $1", [
          property.id,
          "some-internal-process",
        ]);
        const task = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const person = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        const headers = await authHeader();

        const res = await fetch(`${baseUrl}/api/items/${task.id}/relations/${property.key}/${person.id}`, {
          method: "PUT",
          headers,
        });
        expect(res.status).toBe(403);
        const body = (await res.json()) as ErrorBody;
        expect(body.error.code).toBe("owner_violation");
      });
    });

    describe("DELETE", () => {
      it("rejects an unauthenticated request", async () => {
        const res = await fetch(`${baseUrl}/api/items/${randomUUID()}/relations/foo/${randomUUID()}`, {
          method: "DELETE",
        });
        expect(res.status).toBe(401);
      });

      it("returns 404 for a propertyKey that doesn't exist", async () => {
        const { source } = await makePairedRelation();
        const item = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const headers = await authHeader();

        const res = await fetch(`${baseUrl}/api/items/${item.id}/relations/nope/${randomUUID()}`, {
          method: "DELETE",
          headers,
        });
        expect(res.status).toBe(404);
      });

      it("returns 404 deleting a non-existent edge", async () => {
        const { source, target, property } = await makePairedRelation();
        const task = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const person = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        const headers = await authHeader();

        const res = await fetch(`${baseUrl}/api/items/${task.id}/relations/${property.key}/${person.id}`, {
          method: "DELETE",
          headers,
        });
        expect(res.status).toBe(404);
      });

      it("deletes an existing edge and returns 200 with the full relation envelope, never 204", async () => {
        const { source, target, property } = await makePairedRelation();
        const task = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const person = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        const headers = await authHeader();

        const put = await fetch(`${baseUrl}/api/items/${task.id}/relations/${property.key}/${person.id}`, {
          method: "PUT",
          headers,
        });
        const putBody = (await put.json()) as RelationBody;
        const res = await fetch(`${baseUrl}/api/items/${task.id}/relations/${property.key}/${person.id}`, {
          method: "DELETE",
          headers,
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as RelationBody;
        expect(body).toEqual(putBody);
      });

      it("rejects a delete through a system-owned relation property with 403 owner_violation", async () => {
        const source = await chokePoint.createDatabase({ name: "Tasks" });
        const target = await chokePoint.createDatabase({ name: "People" });
        const { property } = await chokePoint.createRelationProperty({
          sourceDatabaseId: source.id,
          key: "systemLink",
          name: "System Link",
          targetDatabaseId: target.id,
        });
        await pool.query("UPDATE properties SET owner = 'system', owner_process = $2 WHERE id = $1", [
          property.id,
          "some-internal-process",
        ]);
        const task = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const person = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        const headers = await authHeader();

        const res = await fetch(`${baseUrl}/api/items/${task.id}/relations/${property.key}/${person.id}`, {
          method: "DELETE",
          headers,
        });
        expect(res.status).toBe(403);
        const body = (await res.json()) as ErrorBody;
        expect(body.error.code).toBe("owner_violation");
      });
    });

    describe("GET list (issue #1404)", () => {
      interface RelationListBody {
        relations: Array<{
          relationPropertyId: string;
          propertyKey: string;
          targetItemId: string;
          targetDatabaseId: string;
          metadata: Record<string, unknown>;
        }>;
      }

      it("rejects an unauthenticated request", async () => {
        const res = await fetch(`${baseUrl}/api/items/${randomUUID()}/relations`);
        expect(res.status).toBe(401);
      });

      it("returns 404 not_found for an unknown item", async () => {
        const headers = await authHeader();
        const res = await fetch(`${baseUrl}/api/items/${randomUUID()}/relations`, { headers });
        expect(res.status).toBe(404);
        expect(((await res.json()) as ErrorBody).error.code).toBe("not_found");
      });

      it("returns an empty list for an item with no edges", async () => {
        const { source } = await makePairedRelation();
        const item = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const headers = await authHeader();

        const res = await fetch(`${baseUrl}/api/items/${item.id}/relations`, { headers });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ relations: [] });
      });

      it("lists a paired edge from each end under that end's own property", async () => {
        const { source, target, property, inverseProperty } = await makePairedRelation();
        const task = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const person = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        await chokePoint.createRelation({
          relationPropertyId: property.id,
          callerItemId: task.id,
          targetItemId: person.id,
          metadata: { role: "owner" },
        });
        const headers = await authHeader();

        const fromTask = await fetch(`${baseUrl}/api/items/${task.id}/relations`, { headers });
        expect(fromTask.status).toBe(200);
        expect(((await fromTask.json()) as RelationListBody).relations).toEqual([
          {
            relationPropertyId: property.id,
            propertyKey: "assignedTo",
            targetItemId: person.id,
            targetDatabaseId: target.id,
            metadata: { role: "owner" },
          },
        ]);

        const fromPerson = await fetch(`${baseUrl}/api/items/${person.id}/relations`, { headers });
        expect(fromPerson.status).toBe(200);
        expect(((await fromPerson.json()) as RelationListBody).relations).toEqual([
          {
            relationPropertyId: inverseProperty.id,
            propertyKey: "assignedTasks",
            targetItemId: task.id,
            targetDatabaseId: source.id,
            metadata: { role: "owner" },
          },
        ]);
      });

      it("narrows to one property with ?propertyKey= and answers 404 for a key that is not a relation of the item's database", async () => {
        const { source, target, property } = await makePairedRelation();
        const { property: watchers } = await chokePoint.createRelationProperty({
          sourceDatabaseId: source.id,
          key: "watchers",
          name: "Watchers",
          targetDatabaseId: target.id,
        });
        await chokePoint.createProperty({ databaseId: source.id, key: "notes", name: "Notes", type: "text" });
        const task = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const person = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        const observer = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        await chokePoint.createRelation({
          relationPropertyId: property.id,
          callerItemId: task.id,
          targetItemId: person.id,
        });
        await chokePoint.createRelation({
          relationPropertyId: watchers.id,
          callerItemId: task.id,
          targetItemId: observer.id,
        });
        const headers = await authHeader();

        const narrowed = await fetch(`${baseUrl}/api/items/${task.id}/relations?propertyKey=watchers`, { headers });
        expect(narrowed.status).toBe(200);
        expect(
          ((await narrowed.json()) as RelationListBody).relations.map((r) => [r.propertyKey, r.targetItemId]),
        ).toEqual([["watchers", observer.id]]);

        for (const key of ["nope", "notes"]) {
          const res = await fetch(`${baseUrl}/api/items/${task.id}/relations?propertyKey=${key}`, { headers });
          expect(res.status, key).toBe(404);
          expect(((await res.json()) as ErrorBody).error.code).toBe("not_found");
        }
      });
    });
  });

  describe("relation property resolution through property.getByKey (issue #432)", () => {
    /**
     * `UNIQUE(database_id, key)` makes more than one match unreachable through a real database, so
     * the ambiguous branch is driven by the real service with only `getPropertyByKey` overridden.
     */
    async function callRelationRoute(method: "GET" | "PUT" | "DELETE") {
      const { source, property } = await makeAmbiguousFixture();
      const item = await chokePoint.createItem({ databaseId: source.id, properties: {} });
      const lookups: unknown[] = [];
      const service = {
        ...createGenericApplicationService(pool, testMetadataResolver),
        async getPropertyByKey(_actor: unknown, input: unknown) {
          lookups.push(input);
          return [property, { ...property, id: randomUUID() }];
        },
      };
      const route = createItemRoutes(service, pool, testMetadataResolver).find((candidate) =>
        method === "GET"
          ? candidate.method === "GET" && candidate.path === "/api/items/:id/relations"
          : candidate.method === method && candidate.path.includes("/relations/"),
      );
      if (!route) throw new Error(`expected a ${method} relation route`);
      const identity = { user: { id: randomUUID() } } as AuthenticatedIdentity;
      const result = await route.handler({
        // The GET list reads its `?propertyKey=` filter from the request URL; the write routes ignore it.
        req: { url: `/api/items/${item.id}/relations?propertyKey=${property.key}` } as IncomingMessage,
        identity,
        params: { id: item.id, propertyKey: property.key, targetItemId: randomUUID() },
        body: undefined,
      });
      return { result, lookups, databaseId: source.id, propertyKey: property.key };
    }

    async function makeAmbiguousFixture() {
      const source = await chokePoint.createDatabase({ name: "Tasks" });
      const target = await chokePoint.createDatabase({ name: "People" });
      const { property } = await chokePoint.createRelationProperty({
        sourceDatabaseId: source.id,
        key: "assignedTo",
        name: "Assigned To",
        targetDatabaseId: target.id,
        inverse: { key: "assignedTasks", name: "Assigned Tasks" },
      });
      return { source, property };
    }

    it.each(["GET", "PUT", "DELETE"] as const)(
      "%s answers 409 validation_failed ambiguous when the lookup returns more than one match",
      async (method) => {
        const { result, lookups, databaseId, propertyKey } = await callRelationRoute(method);
        expect(result).toEqual({
          status: 409,
          body: { error: { code: "validation_failed", details: { field: "propertyKey", reason: "ambiguous" } } },
        });
        expect(lookups).toEqual([{ databaseId, key: propertyKey, type: "relation" }]);
      },
    );
  });

  describe("page restore (issue #1617)", () => {
    const HALF_HOUR_MS = 30 * 60 * 1000;

    /**
     * A page with block `b1`: its history opens two hours before the database clock, and `b1` is dated an
     * hour before it, so an instant half an hour back sits between the two.
     */
    async function pageWithBlock(): Promise<{ itemId: string; now: Date }> {
      const { rows } = await pool.query<{ now: Date }>(`SELECT transaction_timestamp() AS now`);
      const now = rows[0]!.now;
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Chapter" } });
      const docStore = createDocStore(pool);
      const doc = await docStore.getOrCreateDoc(item.id, "page");
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      await pool.query(`UPDATE docs SET history_available_from = $2 WHERE id = $1`, [doc.id, twoHoursAgo]);
      await pool.query(
        `UPDATE doc_snapshot_history SET represented_at = $2 WHERE doc_id = $1 AND through_update_id = 0`,
        [doc.id, twoHoursAgo],
      );
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph", fields: { content: "first" } }, "user");
      await pool.query(`UPDATE doc_updates SET created_at = $2 WHERE doc_id = $1`, [doc.id, oneHourAgo]);
      await pool.query(`UPDATE doc_history_updates SET created_at = $2 WHERE doc_id = $1`, [doc.id, oneHourAgo]);
      return { itemId: item.id, now };
    }

    async function restore(itemId: string, body: unknown): Promise<Response> {
      return fetch(`${baseUrl}/api/items/${itemId}/page/restore`, {
        method: "POST",
        headers: { ...(await authHeader()), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("rejects an unauthenticated request", async () => {
      const res = await fetch(`${baseUrl}/api/items/${randomUUID()}/page/restore`, { method: "POST" });
      expect(res.status).toBe(401);
    });

    it("restores the page to the instant and returns its block ids", async () => {
      const page = await pageWithBlock();
      const at = new Date(page.now.getTime() - HALF_HOUR_MS).toISOString();

      const res = await restore(page.itemId, { at });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ itemId: page.itemId, at, blockIds: ["b1"] });
    });

    it("answers an unknown item with 404", async () => {
      const res = await restore(randomUUID(), { at: new Date(Date.now() - HALF_HOUR_MS).toISOString() });

      expect(res.status).toBe(404);
      expect(((await res.json()) as ErrorBody).error.code).toBe("not_found");
    });

    it("answers an item that has no page with 404", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "No page" } });

      const res = await restore(item.id, { at: new Date(Date.now() - HALF_HOUR_MS).toISOString() });

      expect(res.status).toBe(404);
      expect(((await res.json()) as ErrorBody).error.code).toBe("not_found");
    });

    it("answers an instant before the retained history with 410 history_not_retained", async () => {
      const page = await pageWithBlock();

      const res = await restore(page.itemId, { at: new Date(page.now.getTime() - 24 * 60 * 60 * 1000).toISOString() });

      expect(res.status).toBe(410);
      expect(((await res.json()) as ErrorBody).error.code).toBe("history_not_retained");
    });

    it("answers a future instant and a malformed or missing at with 400", async () => {
      const page = await pageWithBlock();
      const future = new Date(page.now.getTime() + 24 * 60 * 60 * 1000).toISOString();

      for (const body of [{ at: future }, { at: "yesterday" }, {}]) {
        const res = await restore(page.itemId, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(((await res.json()) as ErrorBody).error.code).toBe("validation_failed");
      }
    });
  });

  describe("batch 37 write boundaries over REST (R1)", () => {
    let headers: Record<string, string>;
    let tasksDb: string;

    beforeEach(async () => {
      await seedSystem(pool, createViewTypeRegistry());
      headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const databases = await runInTenant(getTenantZeroId(), () => chokePoint.listDatabases());
      tasksDb = databases.find((database) => database.ownerModuleId === "tasks")?.id ?? "";
      if (!tasksDb) throw new Error("Tasks not seeded");
    });

    async function createTask(properties: Record<string, unknown>): Promise<{ id: string; updatedAt: string }> {
      const created = await runInTenant(getTenantZeroId(), () =>
        chokePoint.createItem({ databaseId: tasksDb, properties: { name: "Task", ...properties } }),
      );
      return { id: created.id, updatedAt: created.updatedAt };
    }

    async function storedItem(id: string): Promise<{ properties: Record<string, unknown>; updatedAt: string }> {
      const item = await runInTenant(getTenantZeroId(), () => chokePoint.getItem(tasksDb, id));
      if (!item) throw new Error(`Item ${id} missing`);
      return { properties: item.properties, updatedAt: item.updatedAt };
    }

    async function storedProperties(id: string): Promise<Record<string, unknown>> {
      return (await storedItem(id)).properties;
    }

    /** A REST PATCH carrying the item's current version, as the generic item.patch requires. */
    function patch(id: string, properties: Record<string, unknown>, ifVersion: string) {
      return fetch(`${baseUrl}/api/items/${id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties, ifVersion }),
      });
    }

    function recurrence(method: "PUT" | "DELETE", id: string, body?: unknown) {
      return fetch(`${baseUrl}/api/tasks/${id}/recurrence`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }

    it("sets a weekly recurrence on a Thursday task, refuses one without a date, and turns it off with DELETE (gh-1665)", async () => {
      const thursday = await createTask({ date: "2026-10-22" });
      const set = await recurrence("PUT", thursday.id, { preset: "weekly" });
      expect(set.status).toBe(200);
      const setProperties = itemProperties.parse(await set.json()).properties;
      expect(setProperties.recurrence).toEqual({
        preset: "weekly",
        mode: "fixed",
        rule: { kind: "weekdays", days: ["thu"] },
      });
      expect(setProperties.seriesId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));

      const undated = await createTask({});
      const before = await storedProperties(undated.id);
      const refused = await recurrence("PUT", undated.id, { preset: "weekly" });
      expect(refused.status).toBe(400);
      expect(httpError.parse(await refused.json()).error).toEqual({
        code: "validation_failed",
        details: { field: "date" },
      });
      expect(await storedProperties(undated.id)).toEqual(before);

      const cleared = await recurrence("DELETE", thursday.id);
      expect(cleared.status).toBe(200);
      expect(itemProperties.parse(await cleared.json()).properties).toMatchObject({
        date: "2026-10-22",
        seriesId: null,
        occurrenceDate: null,
        recurrence: null,
      });
    });

    it.each([
      ["null", null],
      ["an empty string", ""],
    ])(
      "refuses a PATCH of the date to %s on a recurring task with 400 on date, and keeps the row",
      async (_label, date) => {
        const recurring = await createTask({ date: "2026-10-22" });
        expect((await recurrence("PUT", recurring.id, { preset: "weekly" })).status).toBe(200);
        // The PUT wrote the task, so the PATCH carries the version read after it.
        const { properties: before, updatedAt } = await storedItem(recurring.id);
        const response = await patch(recurring.id, { date }, updatedAt);
        expect(response.status).toBe(400);
        expect(httpError.parse(await response.json()).error).toEqual({
          code: "validation_failed",
          details: { field: "date" },
        });
        expect(await storedProperties(recurring.id)).toEqual(before);
      },
    );

    it("clears the date of a task without a series over REST", async () => {
      const once = await createTask({ date: "2026-10-22", timeFrom: "09:00", timeTo: "10:00" });
      const response = await patch(once.id, { date: null }, once.updatedAt);
      expect(response.status).toBe(200);
      expect(await storedProperties(once.id)).toMatchObject({ date: null, timeFrom: null, timeTo: null });
    });

    it("refuses a client PATCH of status missed with 400 on status, and accepts missed to done (gh-1668)", async () => {
      const task = await createTask({ date: "2026-10-22" });
      const before = await storedProperties(task.id);
      const refused = await patch(task.id, { status: "missed" }, task.updatedAt);
      expect(refused.status).toBe(400);
      expect(httpError.parse(await refused.json()).error).toEqual({
        code: "validation_failed",
        details: { field: "status" },
      });
      expect(await storedProperties(task.id)).toEqual(before);

      // The Tasks module, a system writer, may store missed.
      await runInTenant(getTenantZeroId(), () =>
        chokePoint.updateItem({ databaseId: tasksDb, itemId: task.id, propertiesPatch: { status: "missed" } }),
      );
      // The system write changed the version; the PATCH carries the one read after it.
      const done = await patch(task.id, { status: "done" }, (await storedItem(task.id)).updatedAt);
      expect(done.status).toBe(200);
      expect(await storedProperties(task.id)).toMatchObject({ status: "done", completedOn: expect.any(String) });
    });

    it("answers 409 naming the live entry when restoring a Journal entry whose period is held, and 200 otherwise (gh-1666)", async () => {
      const databases = await runInTenant(getTenantZeroId(), () => chokePoint.listDatabases());
      const journalDb = databases.find((database) => database.ownerModuleId === "journal")?.id ?? "";
      if (!journalDb) throw new Error("Journal not seeded");
      const ensure = (period: string) =>
        runInTenant(getTenantZeroId(), () =>
          withTransaction(pool, (client) => ensureJournalPeriodDoc(client, "day", period)),
        );
      const trashed = (await ensure("2026-05-03")).itemId;
      await runInTenant(getTenantZeroId(), () => chokePoint.softDeleteItem(journalDb, trashed));
      const live = (await ensure("2026-05-03")).itemId;
      expect(live).not.toBe(trashed);

      const held = await fetch(`${baseUrl}/api/items/${trashed}/restore`, { method: "POST", headers });
      expect(held.status).toBe(409);
      expect(httpError.parse(await held.json()).error).toEqual({
        code: "version_conflict",
        details: { liveItemId: live },
      });
      const { rows: trashRows } = await pool.query<{ deleted: boolean }>(
        "SELECT deleted_at IS NOT NULL AS deleted FROM items WHERE id = $1",
        [trashed],
      );
      expect(trashRows).toEqual([{ deleted: true }]);

      const alone = (await ensure("2026-05-04")).itemId;
      await runInTenant(getTenantZeroId(), () => chokePoint.softDeleteItem(journalDb, alone));
      const restored = await fetch(`${baseUrl}/api/items/${alone}/restore`, { method: "POST", headers });
      expect(restored.status).toBe(200);
      expect(
        z
          .object({ deletedAt: z.null() })
          .passthrough()
          .parse(await restored.json()).deletedAt,
      ).toBeNull();
    });
  });
});
