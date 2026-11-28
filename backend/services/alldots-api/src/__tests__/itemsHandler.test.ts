import type { CollectionMetadataResolver } from "@alldots/data";
import {
  createBlob,
  createItemWithClient,
  getDatabaseByModuleId,
  getSystemTimezone,
  today,
  insertInboxAttachments,
  listInboxAttachments,
  recordInboxAttachmentMetadata,
} from "@alldots/data";
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
  createSeriesOccurrence,
  registerItemCreateHook,
  registerItemUpdateHook,
  resetDatabase,
  startTaskSeries,
  tenantForNextTestUser,
  upsertMailMessageMeta,
} from "@alldots/data/testSupport";
import {
  createChokePoint,
  createAlldotsTickAction,
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
} from "@alldots/data";
import { runInTenant } from "@alldots/shared";
import { createGenericApplicationService } from "@alldots/application";
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
const tmpBlobDir = join(tmpdir(), `alldots-test-blobs-${randomUUID()}`);

const noopMailer: PasswordResetMailer = {
  async sendPasswordResetEmail() {},
};

let pool: Pool;
let chokePoint: ChokePoint;
const moduleRegistry = await loadFullModuleRegistry();
const dispatcherOptions = {
  passwordResetMailer: noopMailer,
  appBaseUrl: "http://localhost",
  setupToken: "unused-setup-token",
  moduleRegistry,
  blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
  maxFileSizeBytes: 10 * 1024 * 1024,
};

type HeaderMap = Record<string, string>;
type Properties = Record<string, unknown>;

/** The first user after a reset belongs to tenant zero; every later one gets a tenant of its own. */
async function authHeader(locale?: string): Promise<{ Authorization: string }> {
  const user = await createUser(pool, {
    tenantId: await tenantForNextTestUser(pool),
    email: `${randomUUID()}@example.com`,
    passwordHash: await hashPassword(PASSWORD),
    ...(locale === undefined ? {} : { locale }),
  });
  const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  return { Authorization: `Bearer ${token}` };
}

async function jsonAuth(): Promise<HeaderMap> {
  return { ...(await authHeader()), "Content-Type": "application/json" };
}

function req(method: string, headers: HeaderMap = {}, body?: unknown): RequestInit {
  return { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}

function seed(): Promise<unknown> {
  return seedSystem(pool, createViewTypeRegistry());
}

function inZero<T>(fn: () => Promise<T>): Promise<T> {
  return runInTenant(getTenantZeroId(), fn);
}

async function moduleDatabase(moduleId: string, db: Pool = pool) {
  const database = await inZero(() => withTransaction(db, (client) => getDatabaseByModuleId(client, moduleId)));
  if (!database) throw new Error(`Missing ${moduleId} database`);
  return database;
}

async function propertyOf(databaseId: string, key: string, cp: ChokePoint = chokePoint) {
  const property = (await cp.listProperties(databaseId)).find((entry) => entry.key === key);
  if (!property) throw new Error(`Missing property ${key}`);
  return property;
}

function getItemInZero(databaseId: string, itemId: string) {
  return inZero(() => chokePoint.getItem(databaseId, itemId));
}

function storeProposal(databaseId: string, itemId: string, proposal: unknown) {
  return inZero(() =>
    withTransaction(pool, (client) =>
      updateItemWithClient(
        client,
        { databaseId, itemId, propertiesPatch: { proposal } },
        { allowedSystemKeys: ["proposal"] },
      ),
    ),
  );
}

/** An Inbox capture of the given type, ticked once so exactly one proposal card exists for it. */
async function proposalCard(
  type: Properties,
  text: string,
  extracted: Properties,
  beforeTick?: (source: { id: string }, inboxDatabaseId: string) => Promise<void>,
) {
  const inboxDatabaseId = (await moduleDatabase("inbox")).id;
  const inboxItemTypesDatabaseId = (await moduleDatabase("inboxItemTypes")).id;
  const processingProposalsDatabaseId = (await moduleDatabase("processingProposals")).id;
  return inZero(async () => {
    const typeItem = await chokePoint.createItem({ databaseId: inboxItemTypesDatabaseId, properties: type });
    const source = await chokePoint.createItem({
      databaseId: inboxDatabaseId,
      properties: { text, date: "2026-08-28", time: "09:00" },
    });
    await chokePoint.createRelation({
      relationPropertyId: (await propertyOf(inboxDatabaseId, "type")).id,
      callerItemId: source.id,
      targetItemId: typeItem.id,
    });
    await beforeTick?.(source, inboxDatabaseId);
    const tick = createAlldotsTickAction(pool, async () => ({ properties: extracted }));
    await tick(
      { inboxDatabaseId, inboxItemTypesDatabaseId, processingProposalsDatabaseId },
      { heartbeatId: "hb", projectItemId: "proj", itemId: source.id },
    );
    const cards = await chokePoint.listItems(processingProposalsDatabaseId);
    if (cards.items.length !== 1 || !cards.items[0]) throw new Error("Expected one proposal card");
    return { source, processingProposalsDatabaseId, cardId: cards.items[0].id };
  });
}

async function expectError(res: Response, status: number, error: Record<string, unknown> = {}): Promise<void> {
  expect(res.status).toBe(status);
  expect(await res.json()).toMatchObject({ error });
}

async function expectValidation(res: Response, field: string, status = 400): Promise<void> {
  expect(res.status).toBe(status);
  expect(httpError.parse(await res.json()).error).toEqual({ code: "validation_failed", details: { field } });
}

/** Another tenant's id answers exactly like an id that does not exist. */
async function expectForeignLikeMissing(request: (id: string) => Promise<Response>, foreignId: string): Promise<void> {
  const randomId = randomUUID();
  const foreign = await request(foreignId);
  const random = await request(randomId);
  expect(foreign.status).toBe(404);
  expect(random.status).toBe(404);
  expect((await foreign.text()).replaceAll(foreignId, "<id>")).toEqual(
    (await random.text()).replaceAll(randomId, "<id>"),
  );
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

/** Serves the API from the non-superuser runtime role, so row-level security applies to every request. */
async function withRuntimeServer(run: (runtime: Pool, base: string) => Promise<void>): Promise<void> {
  const runtime = await createRuntimeRolePool(pool, "alldots_data");
  let server: Server | undefined;
  const failures: unknown[] = [];
  try {
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    server = createServer(await createDispatcher(runtime, dispatcherOptions));
    await run(runtime, await listen(server));
  } catch (error) {
    failures.push(error);
  }
  try {
    if (server?.listening) await closeServer(server);
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
}

interface ItemBody {
  id: string;
  databaseId: string;
  properties: Record<string, unknown>;
  computed: Record<string, unknown>;
  updatedAt: string;
  version: string;
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

const linkedItemBody = z.object({ links: z.record(z.string(), z.unknown()) });
/** Sources are all items, as the `fileCompaniesFromProjects` rule leaves it. */
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
const httpError = z.object({ error: z.object({ code: z.string(), details: z.record(z.string(), z.unknown()) }) });
const itemProperties = z.object({ properties: z.record(z.string(), z.unknown()) });
const versionedItem = z.object({
  updatedAt: z.string(),
  version: z.string(),
  properties: z.record(z.string(), z.unknown()),
});
const relationTargets = z.object({
  relations: z.array(z.object({ propertyKey: z.string(), targetItemId: z.string() })),
});

describe("item routes", () => {
  let server: Server;
  let baseUrl: string;

  const api = (path: string, init?: RequestInit) => fetch(`${baseUrl}${path}`, init);
  const patchItem = (id: string, headers: HeaderMap, properties: Properties, ifVersion: string, base = baseUrl) =>
    fetch(`${base}/api/items/${id}`, req("PATCH", headers, { properties, ifVersion }));
  /** PATCHes at the stored version of the item. */
  const patchCurrent = async (databaseId: string, itemId: string, headers: HeaderMap, properties: Properties) => {
    const current = await getItemInZero(databaseId, itemId);
    if (!current) throw new Error("Missing item");
    return patchItem(itemId, headers, properties, current.version);
  };
  const createIn = (databaseId: string, headers: HeaderMap, body: unknown) =>
    api(`/api/databases/${databaseId}/items`, req("POST", headers, body));
  const queryDb = (databaseId: string, headers: HeaderMap, body: unknown = {}) =>
    api(`/api/databases/${databaseId}/query`, req("POST", headers, body));
  const queryView = (viewId: string, headers: HeaderMap, body: unknown = {}) =>
    api(`/api/views/${viewId}/query`, req("POST", headers, body));
  const confirmProposal = (cardId: string, headers: HeaderMap) =>
    api(`/api/proposals/${cardId}/confirm`, { method: "POST", headers, body: "{}" });

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    server = createServer(await createDispatcher(pool, dispatcherOptions));
    baseUrl = await listen(server);
  });

  afterEach(async () => {
    await closeServer(server);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("enforces derived relation admission through runtime HTTP", async () => {
    await seed();
    const headers = await jsonAuth();
    const foreignHeaders = await jsonAuth();
    await withRuntimeServer(async (runtime, base) => {
      const cp = createChokePoint(runtime);
      const f = await inZero(async () => {
        const db = async (key: string) => (await moduleDatabase(key, runtime)).id;
        const make = async (key: string, properties: Properties) =>
          cp.createItem({ databaseId: await db(key), properties });
        const link = async (databaseKey: string, key: string, callerItemId: string, targetItemId: string) =>
          cp.createRelation({
            relationPropertyId: (await propertyOf(await db(databaseKey), key, cp)).id,
            callerItemId,
            targetItemId,
          });
        const event = await make("events", { name: "Event", date: "2026-10-16" });
        const open = await make("events", { name: "Open", date: "2026-10-16" });
        const project = await make("projects", { name: "Project" });
        const company = await make("companies", { name: "Company" });
        await link("events", "project", event.id, project.id);
        return { event, open, company };
      });
      const put = (source: string, key: string, target: string, requestHeaders = headers) =>
        fetch(`${base}/api/items/${source}/relations/${key}/${target}`, { method: "PUT", headers: requestHeaders });
      expect((await put(f.open.id, "company", f.company.id)).status).toBe(200);
      for (const [source, key, target] of [
        [f.event.id, "company", f.company.id],
        [f.company.id, "meetings", f.event.id],
      ] as const) {
        await expectError(await put(source, key, target), 400, { details: { field: "company" } });
      }
      await expectForeignLikeMissing((id) => put(id, "company", f.company.id, foreignHeaders), f.event.id);
      const targets = async (itemId: string) =>
        ((await inZero(() => createChokePoint(runtime).listItemRelations(itemId))) ?? []).map(
          (edge) => edge.targetItemId,
        );
      expect(await targets(f.event.id)).not.toContain(f.company.id);
      expect(await targets(f.open.id)).toContain(f.company.id);
    });
  });

  it("enforces Tasks completion and both protected relation pairs through authenticated runtime HTTP", async () => {
    await seed();
    const headers = await jsonAuth();
    const foreignHeaders = await jsonAuth();
    await withRuntimeServer(async (runtime, base) => {
      const cp = createChokePoint(runtime);
      const tasksDb = (await moduleDatabase("tasks", runtime)).id;
      const eventsDb = (await moduleDatabase("events", runtime)).id;
      const peopleDb = (await moduleDatabase("people", runtime)).id;
      const f = await inZero(async () => ({
        task: await cp.createItem({ databaseId: tasksDb, properties: { name: "Task", date: "2099-10-22" } }),
        event: await cp.createItem({ databaseId: eventsDb, properties: { name: "Event", date: "2026-10-16" } }),
        inverseTask: await cp.createItem({ databaseId: tasksDb, properties: { name: "Inverse Task" } }),
        inverseEvent: await cp.createItem({
          databaseId: eventsDb,
          properties: { name: "Inverse Event", date: "2026-10-16" },
        }),
        person: await cp.createItem({ databaseId: peopleDb, properties: { name: "Person" } }),
      }));
      const relationUrl = (source: string, key: string, target: string) =>
        `${base}/api/items/${source}/relations/${key}/${target}`;
      const edgeCount = async () =>
        (await inZero(() => runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM item_relations")))
          .rows;
      const edgesBefore = await edgeCount();
      for (const [source, key, target] of [
        [f.task.id, "hostEvents", f.event.id],
        [f.event.id, "hostedTasks", f.task.id],
        [f.task.id, "completedInEvent", f.event.id],
        [f.event.id, "completedTasks", f.task.id],
      ] as const) {
        for (const method of ["PUT", "DELETE"] as const) {
          await expectError(await fetch(relationUrl(source, key, target), { method, headers }), 403, {
            code: "owner_violation",
          });
          await expectForeignLikeMissing(
            (id) => fetch(relationUrl(id, key, target), { method, headers: foreignHeaders }),
            source,
          );
        }
      }
      expect(await edgeCount()).toEqual(edgesBefore);
      const pairs = [
        [f.event.id, "actionItems", f.task.id, "sourceEvents"],
        [f.inverseTask.id, "sourceEvents", f.inverseEvent.id, "actionItems"],
      ] as const;
      for (const [source, key, target] of pairs) {
        await expectForeignLikeMissing(
          (id) => fetch(relationUrl(id, key, target), { method: "PUT", headers: foreignHeaders }),
          source,
        );
      }
      expect(await edgeCount()).toEqual(edgesBefore);
      for (const [source, key, target, inverseKey] of pairs) {
        expect((await fetch(relationUrl(source, key, target), { method: "PUT", headers })).status).toBe(200);
        for (const [id, propertyKey, targetItemId] of [
          [source, key, target],
          [target, inverseKey, source],
        ] as const) {
          const response = await fetch(`${base}/api/items/${id}/relations?propertyKey=${propertyKey}`, { headers });
          expect(response.status).toBe(200);
          expect(relationTargets.parse(await response.json()).relations).toEqual([{ propertyKey, targetItemId }]);
        }
      }
      expect((await fetch(relationUrl(f.task.id, "people", f.person.id), { method: "PUT", headers })).status).toBe(200);
      const itemUrl = (id: string) => `${base}/api/items/${id}`;
      const read = async (id: string) => versionedItem.parse(await (await fetch(itemUrl(id), { headers })).json());
      const before = await read(f.task.id);
      await expectForeignLikeMissing(
        (id) => patchItem(id, foreignHeaders, { status: "done" }, before.version, base),
        f.task.id,
      );
      await expectError(
        await patchItem(f.task.id, headers, { status: "done", completedOn: "2999-01-01" }, before.version, base),
        400,
        { code: "validation_failed", details: { field: "completedOn" } },
      );
      expect(await read(f.task.id)).toEqual(before);
      const done = await patchItem(f.task.id, headers, { status: "done" }, before.version, base);
      expect(done.status).toBe(200);
      expect(versionedItem.parse(await done.json()).properties).toMatchObject({
        status: "done",
        date: "2099-10-22",
        completedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        completedAt: expect.any(String),
      });
      const rollover = await inZero(async () => ({
        task: await cp.createItem({
          databaseId: tasksDb,
          properties: { name: "Moved", date: "2000-01-01", timeFrom: "10:00", timeTo: "11:00" },
        }),
        view: await cp.createView({ databaseId: tasksDb, type: "table", name: "Tasks", config: {} }),
      }));
      const movedResponse = await patchItem(
        rollover.task.id,
        headers,
        { date: "2000-01-02" },
        rollover.task.version,
        base,
      );
      expect(movedResponse.status).toBe(200);
      const moved = versionedItem.parse(await movedResponse.json());
      const expected = { since: "2000-01-01", sinceTime: { from: "10:00", to: "11:00" } };
      expect(moved.properties).toMatchObject(expected);
      expect((await read(rollover.task.id)).properties).toMatchObject(expected);
      await expectForeignLikeMissing((id) => fetch(itemUrl(id), { headers: foreignHeaders }), rollover.task.id);
      const viewQuery = (id: string, requestHeaders: HeaderMap) =>
        fetch(`${base}/api/views/${id}/query`, { method: "POST", headers: requestHeaders, body: "{}" });
      const viewResponse = await viewQuery(rollover.view.id, headers);
      expect(viewResponse.status).toBe(200);
      const viewBody = z
        .object({ items: z.array(z.object({ id: z.string(), properties: z.record(z.string(), z.unknown()) })) })
        .parse(await viewResponse.json());
      expect(viewBody.items.find((item) => item.id === rollover.task.id)?.properties).toMatchObject(expected);
      await expectForeignLikeMissing((id) => viewQuery(id, foreignHeaders), rollover.view.id);
      for (const properties of [
        { since: "1999-01-01" },
        { sinceTime: { from: "08:00", to: null } },
        { completedAt: "2020-01-01T00:00:00Z" },
      ]) {
        await expectError(await patchItem(rollover.task.id, headers, properties, moved.version, base), 403, {
          code: "owner_violation",
        });
      }
      expect(await read(rollover.task.id)).toEqual(moved);
    });
  });

  it("writes and reads People phones through item routes", async () => {
    await seed();
    const headers = await jsonAuth();
    const people = await moduleDatabase("people");
    const created = await createIn(people.id, headers, { properties: { name: "Person", phones: "777 123 456" } });
    expect(created.status).toBe(201);
    const item = z.object({ id: z.string() }).parse(await created.json());
    const response = await api(`/api/items/${item.id}`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ properties: { phones: "777 123 456" } });
  });

  it("includes Journal day metadata in page breadcrumbs", async () => {
    await seed();
    const headers = await authHeader();
    const day = await inZero(() =>
      withTransaction(pool, (client) => ensureJournalPeriodDoc(client, "day", "2026-10-16")),
    );
    const response = await api(`/api/items/${day.itemId}/page`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      breadcrumbs: [expect.objectContaining({ itemId: day.itemId, journal: { type: "day", period: "2026-10-16" } })],
    });
  });

  it("uses each database's title property in inline page breadcrumbs", async () => {
    const headers = await authHeader();
    const { parent, child } = await inZero(async () => {
      const parentDb = await chokePoint.createDatabase({ name: "Parent" });
      await chokePoint.createProperty({ databaseId: parentDb.id, key: "heading", name: "Heading", type: "title" });
      const parent = await chokePoint.createItem({ databaseId: parentDb.id, properties: { heading: "Parent title" } });
      const childDb = await chokePoint.createInlineDatabase({ name: "Child", parentItemId: parent.id });
      await chokePoint.createProperty({ databaseId: childDb.id, key: "caption", name: "Caption", type: "title" });
      const child = await chokePoint.createItem({ databaseId: childDb.id, properties: { caption: "Child title" } });
      return { parent, child };
    });
    const response = await api(`/api/items/${child.id}/page`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      breadcrumbs: [
        { itemId: parent.id, title: "Parent title" },
        { itemId: child.id, title: "Child title" },
      ],
    });
  });

  it("ensures one page across concurrent HTTP calls and refuses trashed or wrong-kind items", async () => {
    const headers = await authHeader();
    const f = await inZero(async () => {
      const database = await chokePoint.createDatabase({ name: "Ensure pages" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
      const canvas = await chokePoint.createItem({ databaseId: database.id, properties: {} });
      await createDocStore(pool).getOrCreateDoc(canvas.id, "canvas");
      return { database, item, canvas };
    });
    const path = `/api/items/${f.item.id}/page`;
    const [first, second] = await Promise.all([
      api(path, { method: "PUT", headers }),
      api(path, { method: "PUT", headers }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = z.object({ docId: z.string() }).parse(await first.json());
    expect(await second.json()).toEqual(firstBody);
    expect(await (await api(path, { method: "PUT", headers })).json()).toEqual(firstBody);
    expect(await (await api(path, { headers })).json()).toMatchObject(firstBody);
    const stored = await pool.query<{ id: string }>("SELECT id FROM docs WHERE item_id = $1", [f.item.id]);
    expect(stored.rows).toEqual([{ id: firstBody.docId }]);
    expect((await api(`/api/items/${f.canvas.id}/page`, { method: "PUT", headers })).status).toBe(409);
    const canvasRows = await pool.query<{ kind: string }>("SELECT kind FROM docs WHERE item_id = $1", [f.canvas.id]);
    expect(canvasRows.rows).toEqual([{ kind: "canvas" }]);
    await inZero(() => chokePoint.softDeleteItem(f.database.id, f.item.id));
    expect((await api(path, { method: "PUT", headers })).status).toBe(404);
    expect((await api(path, { method: "PUT" })).status).toBe(401);
  });

  it("refuses a canvas as a page over HTTP without changing its document", async () => {
    const headers = await authHeader();
    const item = await inZero(async () => {
      const database = await chokePoint.createDatabase({ name: "Canvas" });
      return chokePoint.createItem({ databaseId: database.id, properties: {} });
    });
    await inZero(() =>
      createDocStore(pool).putCanvasElement(
        item.id,
        { id: "shape", type: "shape", xywh: [0, 0, 10, 10], index: "a0" },
        "user",
      ),
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
    await expectError(await api(`/api/items/${item.id}/page`, { headers }), 409, { code: "version_conflict" });
    expect((await state()).rows).toEqual(before.rows);
  });

  it("reads page summaries over HTTP without creating a document and counts beyond the limit", async () => {
    const headers = await authHeader();
    const item = await inZero(async () => {
      const database = await chokePoint.createDatabase({ name: "Pages" });
      return chokePoint.createItem({ databaseId: database.id, properties: {} });
    });
    const path = `/api/items/${item.id}/page`;
    const empty = await api(path, { headers });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ docId: null, blockCount: 0, subpageCount: 0, breadcrumbs: null });
    expect((await pool.query("SELECT id FROM docs WHERE item_id = $1", [item.id])).rows).toHaveLength(0);
    const row = await inZero(() => createDocStore(pool).getOrCreateDoc(item.id, "page"));
    await inZero(() =>
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
    const limited = await api(`${path}?limit=5`, { headers });
    expect(limited.status).toBe(200);
    expect(await limited.json()).toMatchObject({
      docId: row.id,
      blockCount: 14,
      subpageCount: 2,
      blocks: [{ pageId: "page-0" }, { pageId: "page-1" }, {}, {}, {}],
    });
    const markdown = await api(`${path}?format=markdown`, { headers });
    expect(markdown.status).toBe(200);
    expect(await markdown.json()).toMatchObject({ docId: row.id, kind: "page", markdown: expect.any(String) });
    await expectError(await api(`${path}?format=html`, { headers }), 400, { details: { field: "format" } });
    expect((await api(path)).status).toBe(401);
  });

  it("refuses deletion of a system project through REST", async () => {
    await seed();
    const headers = await authHeader();
    const projects = await moduleDatabase("projects");
    const item = (await inZero(() => chokePoint.listItems(projects.id))).items.find(
      (row) => row.properties.systemActive === true,
    );
    if (!item) throw new Error("System project missing");
    await expectError(await api(`/api/items/${item.id}`, { method: "DELETE", headers }), 403, {
      details: { field: "systemActive" },
    });
    expect(await getItemInZero(projects.id, item.id)).toEqual(item);
  });

  it("returns project completion dates and refuses direct writes through REST", async () => {
    await seed();
    const headers = await jsonAuth();
    const projects = await moduleDatabase("projects");
    const item = await inZero(() =>
      chokePoint.createItem({ databaseId: projects.id, properties: { name: "Project", status: "inProgress" } }),
    );
    const day = today(await inZero(() => withTransaction(pool, getSystemTimezone)));
    const done = await patchCurrent(projects.id, item.id, headers, { status: "done" });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ properties: { status: "done", completedAt: day } });
    expect((await patchCurrent(projects.id, item.id, headers, { completedAt: "2000-01-01" })).status).toBe(403);
    expect((await getItemInZero(projects.id, item.id))?.properties.completedAt).toBe(day);
  });

  it("hides a kept project deadline in REST reads and the search index", async () => {
    await seed();
    const headers = await jsonAuth();
    const projects = await moduleDatabase("projects");
    const item = await inZero(() =>
      chokePoint.createItem({
        databaseId: projects.id,
        properties: { name: "Distinctiveproject", status: "inProgress", date: "2042-11-30" },
      }),
    );
    const patch = (properties: Properties) => patchCurrent(projects.id, item.id, headers, properties);
    const changed = await patch({ status: "longTerm" });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ properties: { status: "longTerm", date: null } });
    await expectError(await patch({ date: "2043-01-01" }), 400, {
      code: "validation_failed",
      details: { field: "date" },
    });
    const read = await api(`/api/items/${item.id}`, { headers });
    expect(read.status).toBe(200);
    const body: unknown = await read.json();
    expect(body).toMatchObject({ properties: { date: null } });
    expect(JSON.stringify(body)).not.toContain("2042-11-30");
    const index = await inZero(() =>
      pool.query<{ name_match: boolean; date_match: boolean }>(
        `SELECT search_vector @@ websearch_to_tsquery('czech', 'Distinctiveproject') AS name_match,
       search_vector @@ websearch_to_tsquery('czech', '2042-11-30') AS date_match
       FROM item_search_index WHERE item_id=$1`,
        [item.id],
      ),
    );
    expect(index.rows).toEqual([{ name_match: true, date_match: false }]);
    const restored = await patch({ status: "inProgress" });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ properties: { date: "2042-11-30" } });
  });

  it("validates color writes over authenticated REST and preserves legacy colors on unrelated updates", async () => {
    const headers = await jsonAuth();
    const { database, item } = await inZero(async () => {
      const database = await chokePoint.createDatabase({ name: "Colors" });
      await chokePoint.createProperty({ databaseId: database.id, key: "color", name: "Color", type: "color" });
      await chokePoint.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "text" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: { color: "#FF3B30" } });
      return { database, item };
    });
    const storedColor = async () => (await getItemInZero(database.id, item.id))?.properties.color;
    for (const color of ["red", "Červená"]) {
      await expectError(await patchItem(item.id, headers, { color }, item.version), 400, {
        code: "validation_failed",
        details: { field: "color" },
      });
      expect(await storedColor()).toBe("#FF3B30");
    }
    expect((await patchItem(item.id, headers, { color: "#ff3b30" }, item.version)).status).toBe(200);
    expect(await storedColor()).toBe("#ff3b30");
    expect((await patchCurrent(database.id, item.id, headers, { color: null })).status).toBe(200);
    // Values that predate validation cannot be written through the current API.
    await pool.query("UPDATE items SET properties = jsonb_set(properties, '{color}', $1::jsonb) WHERE id = $2", [
      JSON.stringify("red"),
      item.id,
    ]);
    expect((await patchCurrent(database.id, item.id, headers, { name: "Renamed" })).status).toBe(200);
    expect(await storedColor()).toBe("red");
  });

  it("rejects an invalid proposal color atomically and confirms a valid color", async () => {
    await seed();
    const headers = await jsonAuth();
    const projects = (await moduleDatabase("projects")).id;
    const card = await proposalCard(
      { name: "Project", emoji: "P", processingMethod: "database", targetDatabase: "projects" },
      "Project",
      { name: "New Project" },
    );
    const store = (color: string) =>
      storeProposal(card.processingProposalsDatabaseId, card.cardId, {
        entityKind: "database",
        target: projects,
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
      });
    await store("red");
    const beforeCard = await getItemInZero(card.processingProposalsDatabaseId, card.cardId);
    const before = await inZero(() => chokePoint.listItems(projects));
    await expectError(await confirmProposal(card.cardId, headers), 400, {
      code: "validation_failed",
      details: { field: "color" },
    });
    expect(await getItemInZero(card.processingProposalsDatabaseId, card.cardId)).toEqual(beforeCard);
    expect(await inZero(() => chokePoint.listItems(projects))).toEqual(before);
    await store("#FF3B30");
    expect((await confirmProposal(card.cardId, headers)).status).toBe(200);
    const after = await inZero(() => chokePoint.listItems(projects));
    expect(
      after.items.some((item) => item.properties.name === "New Project" && item.properties.color === "#FF3B30"),
    ).toBe(true);
  });

  it("validates Inbox capture and type writes through REST and replays a capture without duplicating its day edge", async () => {
    await seed();
    const headers = await jsonAuth();
    const inbox = await moduleDatabase("inbox");
    const types = await moduleDatabase("inboxItemTypes");
    const create = (databaseId: string, properties: Properties, key = randomUUID()) =>
      createIn(databaseId, { ...headers, "Idempotency-Key": key }, { properties });
    const count = async (databaseId: string) => (await inZero(() => chokePoint.listItems(databaseId))).items.length;
    const invalidType = (targetDatabase: string) => ({ name: "Invalid", processingMethod: "database", targetDatabase });
    for (const [databaseId, properties, field] of [
      [inbox.id, { date: "2026-02-30", time: "12:00" }, "date"],
      [inbox.id, { date: "2026-10-16", time: "24:00" }, "time"],
      [types.id, invalidType("journal"), "targetDatabase"],
      [types.id, invalidType("transcripts"), "targetDatabase"],
      [types.id, invalidType("nonsense"), "targetDatabase"],
    ] as const) {
      const before = await count(databaseId);
      await expectError(await create(databaseId, properties), 400, { code: "validation_failed", details: { field } });
      expect(await count(databaseId)).toBe(before);
    }
    const key = randomUUID();
    const first = await create(inbox.id, { date: "2026-10-16", time: "12:00" }, key);
    const replay = await create(inbox.id, { date: "2026-10-16", time: "12:00" }, key);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    const idOnly = z.object({ id: z.string() });
    const itemId = idOnly.parse(await first.json()).id;
    expect(idOnly.parse(await replay.json()).id).toBe(itemId);
    expect(await count(inbox.id)).toBe(1);
    const days = await inZero(async () => {
      const { rows } = await pool.query<{ period: string }>(
        `SELECT day.properties->>'period' AS period FROM item_relations r
         JOIN relation_definitions d ON d.id = r.relation_definition_id
         JOIN properties p ON p.id = d.property_id_a
         JOIN items day ON day.id = r.item_b
         WHERE p.database_id = $1 AND p.key = 'journalDay' AND r.item_a = $2`,
        [inbox.id, itemId],
      );
      return rows;
    });
    expect(days).toEqual([{ period: "2026-10-16" }]);
    const valid = await create(types.id, { name: "Valid", processingMethod: "database", targetDatabase: "tasks" });
    expect(valid.status).toBe(201);
    const typeItem = versionedItem.extend({ id: z.string() }).parse(await valid.json());
    for (const properties of [
      { targetDatabase: "journal" },
      { targetDatabase: "transcripts" },
      { targetDatabase: "nonsense" },
      { processingMethod: "pageContent" },
    ]) {
      await expectError(await patchItem(typeItem.id, headers, properties, typeItem.version), 400, {
        code: "validation_failed",
        details: { field: "targetDatabase" },
      });
      expect((await getItemInZero(types.id, typeItem.id))?.properties).toMatchObject({
        processingMethod: "database",
        targetDatabase: "tasks",
      });
    }
    // Simulates a journal target persisted before validation disallowed it.
    const legacy = await inZero(() =>
      pool.query<{ id: string }>(
        "UPDATE items SET properties = jsonb_set(properties, '{targetDatabase}', to_jsonb($3::text)) WHERE database_id = $1 AND id = $2 RETURNING id",
        [types.id, typeItem.id, "journal"],
      ),
    );
    expect(legacy.rows).toHaveLength(1);
    const renamed = await patchCurrent(types.id, typeItem.id, headers, { name: "Renamed" });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ properties: { name: "Renamed", targetDatabase: "journal" } });
  });

  it("refuses system-owned field edits while allowing user-owned fields through the runtime route", async () => {
    await seed();
    const headers = await jsonAuth();
    await withRuntimeServer(async (runtime, base) => {
      const mailboxes = await moduleDatabase("mailboxes", runtime);
      const proposals = await moduleDatabase("processingProposals", runtime);
      const f = await inZero(() =>
        withTransaction(runtime, async (client) => {
          const mailbox = await createItemWithClient(client, {
            databaseId: mailboxes.id,
            properties: { name: "Before" },
          });
          await updateItemWithClient(
            client,
            { databaseId: mailboxes.id, itemId: mailbox.id, propertiesPatch: { addresses: "owner@example.test" } },
            { allowedSystemKeys: ["addresses"] },
          );
          const card = await createItemWithClient(
            client,
            { databaseId: proposals.id, properties: { kind: "inbox", reason: "Original" } },
            { allowedSystemKeys: ["kind", "reason"] },
          );
          return { mailbox, card };
        }),
      );
      const note = await inZero(async () => {
        const api = createChokePoint(runtime);
        const database = await api.createDatabase({ name: "User fields" });
        await api.createProperty({ databaseId: database.id, key: "note", name: "Note", type: "text" });
        return api.createItem({ databaseId: database.id, properties: { note: "before" } });
      });
      const read = async (id: string) =>
        versionedItem.parse(await (await fetch(`${base}/api/items/${id}`, { headers })).json());
      for (const [id, refusedPatch, allowedPatch, allowedResult] of [
        [
          f.mailbox.id,
          { addresses: "bad@example.test" },
          { name: "Allowed" },
          { name: "Allowed", addresses: "owner@example.test" },
        ],
        [f.card.id, { reason: "Injected" }, undefined, undefined],
      ] as const) {
        const before = await read(id);
        await expectError(await patchItem(id, headers, refusedPatch, before.version, base), 403, {
          code: "owner_violation",
        });
        expect(await read(id)).toEqual(before);
        if (allowedPatch) {
          const allowed = await patchItem(id, headers, allowedPatch, before.version, base);
          expect(allowed.status).toBe(200);
          expect(await allowed.json()).toMatchObject({ properties: allowedResult });
        }
      }
      const allowed = await patchItem(note.id, headers, { note: "after" }, note.version, base);
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toMatchObject({ properties: { note: "after" } });
    });
  });

  it("queues one mailbox sync through REST flag patches", async () => {
    await seed();
    const headers = await jsonAuth();
    await withRuntimeServer(async (runtime, base) => {
      const emails = await moduleDatabase("emails", runtime);
      const mailboxes = await moduleDatabase("mailboxes", runtime);
      const f = await inZero(() =>
        withTransaction(runtime, async (client) => {
          const mailbox = await createItemWithClient(client, {
            databaseId: mailboxes.id,
            properties: { name: "Work", provider: "generic" },
          });
          const messages = [];
          for (const messageId of ["<first@example.test>", "<second@example.test>"]) {
            const item = await createItemWithClient(client, { databaseId: emails.id, properties: {} });
            await upsertMailMessageMeta(client, {
              arrival: "live",
              contentState: "full",
              itemId: item.id,
              mailboxItemId: mailbox.id,
              messageId,
              envelope: {},
            });
            messages.push(item);
          }
          return { mailbox, messages };
        }),
      );
      for (const [item, properties] of [
        [f.messages[0], { read: true }],
        [f.messages[1], { flagged: true }],
      ] as const) {
        if (!item) throw new Error("Missing message");
        expect((await patchItem(item.id, headers, properties, item.version, base)).status).toBe(200);
      }
      const { rows } = await pool.query<{ key: string | null }>(
        "SELECT key FROM graphile_worker.jobs WHERE task_identifier = $1",
        ["mailAccountSync"],
      );
      expect(rows).toEqual([{ key: `mail-account-sync:${f.mailbox.id}` }]);
    });
  });

  it("validates Books ratings through the PATCH HTTP response", async () => {
    await seed();
    const headers = await jsonAuth();
    const books = await moduleDatabase("books");
    for (const [rating, valid] of [
      [7, false],
      [2.5, false],
      [0, true],
      [1, true],
      [5, true],
    ] as const) {
      const item = await inZero(() => chokePoint.createItem({ databaseId: books.id, properties: { name: "Book" } }));
      const response = await patchItem(item.id, headers, { rating }, item.version);
      if (valid) {
        expect(response.status).toBe(200);
        expect(
          z.object({ properties: z.object({ rating: z.number() }) }).parse(await response.json()).properties.rating,
        ).toBe(rating);
      } else {
        await expectValidation(response, "rating");
        expect((await getItemInZero(books.id, item.id))?.properties.rating).toBeUndefined();
      }
    }
  });

  it("validates Tasks schedule patches and replays a create through HTTP", async () => {
    await seed();
    const headers = await jsonAuth();
    const tasks = await moduleDatabase("tasks");
    const task = await inZero(() => chokePoint.createItem({ databaseId: tasks.id, properties: { name: "Plan" } }));
    for (const [properties, field] of [
      [{ timeFrom: "10:00" }, "timeFrom"],
      [{ name: "  " }, "name"],
      [{ date: "2026-02-30" }, "date"],
      [{ date: "2026-10-13", timeTo: "15:00" }, "timeTo"],
      [{ date: "2026-10-13", timeFrom: "10:00", timeTo: "09:30" }, "timeTo"],
      [{ date: "2026-10-13", timeFrom: "23:55", timeTo: "23:55" }, "timeTo"],
    ] as const) {
      await expectError(await patchItem(task.id, headers, properties, task.version), 400, {
        code: "validation_failed",
        details: { field },
      });
      const unchanged = await getItemInZero(tasks.id, task.id);
      expect(unchanged?.properties).toEqual(task.properties);
      expect(unchanged?.updatedAt).toBe(task.updatedAt);
    }
    const patch = async (properties: Properties, ifVersion: string) => {
      const response = await patchItem(task.id, headers, properties, ifVersion);
      expect(response.status).toBe(200);
      return versionedItem.parse(await response.json());
    };
    const normalized = await patch({ date: "2026-10-13", timeFrom: "9:00" }, task.version);
    expect(normalized.properties).toMatchObject({ timeFrom: "09:00", time: "09:00" });
    const late = await patch({ timeFrom: "23:55", timeTo: "24:00" }, normalized.version);
    expect(late.properties).toMatchObject({ timeFrom: "23:55", timeTo: "24:00", time: "23:55–24:00" });
    const cleared = await patch({ date: null }, late.version);
    expect(cleared.properties).toMatchObject({ date: null, timeFrom: null, timeTo: null, time: null });
    const replayHeaders = { ...headers, "Idempotency-Key": randomUUID() };
    const request = () =>
      createIn(tasks.id, replayHeaders, { properties: { name: "Replay", date: "2026-10-13", timeFrom: "9:00" } });
    const first = await request();
    const second = await request();
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const itemSchema = z.object({ id: z.string(), properties: z.object({ timeFrom: z.string(), time: z.string() }) });
    const two = itemSchema.parse(await second.json());
    expect(two).toEqual(itemSchema.parse(await first.json()));
    expect(two.properties).toEqual({ timeFrom: "09:00", time: "09:00" });
  });

  it("validates watchedWith ratings through the PUT HTTP response", async () => {
    await seed();
    const headers = await jsonAuth();
    const movies = await moduleDatabase("movies");
    const people = await moduleDatabase("people");
    const { movie, person } = await inZero(async () => ({
      movie: await chokePoint.createItem({ databaseId: movies.id, properties: { name: "Film" } }),
      person: await chokePoint.createItem({ databaseId: people.id, properties: { name: "Person" } }),
    }));
    const url = `/api/items/${movie.id}/relations/watchedWith/${person.id}`;
    await expectValidation(await api(url, req("PUT", headers, { metadata: { rating: 9 } })), "metadata.rating");
    const edges = await inZero(() =>
      pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM item_relations WHERE (item_a = $1 AND item_b = $2) OR (item_a = $2 AND item_b = $1)",
        [movie.id, person.id],
      ),
    );
    expect(edges.rows).toEqual([{ count: 0 }]);
    for (const metadata of [{ rating: 4 }, {}]) {
      const response = await api(url, req("PUT", headers, { metadata }));
      expect(response.status).toBe(200);
      expect(z.object({ metadata: z.record(z.string(), z.unknown()) }).parse(await response.json()).metadata).toEqual(
        metadata,
      );
    }
  });

  it("leaves the same rating keys on another module unaffected over HTTP", async () => {
    const headers = await jsonAuth();
    const { item, person } = await inZero(async () => {
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
    const patch = await patchItem(item.id, headers, { rating: 7 }, item.version);
    expect(patch.status).toBe(200);
    expect(z.object({ properties: z.object({ rating: z.number() }) }).parse(await patch.json()).properties.rating).toBe(
      7,
    );
    const edge = await api(
      `/api/items/${item.id}/relations/watchedWith/${person.id}`,
      req("PUT", headers, { metadata: { rating: 9 } }),
    );
    expect(edge.status).toBe(200);
    expect(z.object({ metadata: z.object({ rating: z.number() }) }).parse(await edge.json()).metadata.rating).toBe(9);
  });

  it("refuses foreign and forbidden file-step inputs over HTTP without writes, then confirms its own attachment", async () => {
    await seed();
    const headers = await jsonAuth();
    const tasks = (await moduleDatabase("tasks")).id;
    const files = (await moduleDatabase("files")).id;
    let foreignId = "";
    let attachment = { own: "", foreign: "", blobId: "" };
    const card = await proposalCard(
      { name: "Task", emoji: "T", processingMethod: "database", targetDatabase: "tasks" },
      "Own",
      { name: "Task" },
      async (source, inboxDatabaseId) => {
        const foreign = await chokePoint.createItem({
          databaseId: inboxDatabaseId,
          properties: { text: "Other", date: "2026-08-28", time: "09:00" },
        });
        foreignId = foreign.id;
        attachment = await withTransaction(pool, async (client) => {
          const blob = () =>
            createBlob(client, {
              mimeType: "image/jpeg",
              byteSize: 3,
              storageKey: `${getTenantZeroId()}/blobs/${randomUUID()}`,
            });
          const ownBlob = await blob();
          const otherBlob = await blob();
          await insertInboxAttachments(client, source.id, [{ blobId: ownBlob.id, source: "camera" }]);
          await insertInboxAttachments(client, foreign.id, [{ blobId: otherBlob.id, source: "camera" }]);
          const [own] = await listInboxAttachments(client, [source.id]);
          const [other] = await listInboxAttachments(client, [foreign.id]);
          if (!own || !other) throw new Error("Missing test attachments");
          // A tick waits for an image whose metadata job has not run; these photos count as unreadable.
          for (const row of [own, other])
            await recordInboxAttachmentMetadata(client, {
              attachmentId: row.attachmentId,
              metadata: { pages: null, error: "mediaUnreadable" },
              thumbnail: null,
              reduced: null,
            });
          return { own: own.attachmentId, foreign: other.attachmentId, blobId: ownBlob.id };
        });
      },
    );
    const store = (properties: Properties) =>
      storeProposal(card.processingProposalsDatabaseId, card.cardId, {
        entityKind: "database",
        target: tasks,
        properties: { name: "Task" },
        operations: [
          { ref: "task", op: "create", role: "primary", databaseKey: "tasks", properties: { name: "Task" } },
          { ref: "file", op: "fileFromAttachment", role: "secondary", properties },
        ],
      });
    const snapshot = async () => {
      const items = await pool.query<Record<string, unknown>>(
        "SELECT id, properties FROM items WHERE database_id = ANY($1::uuid[]) ORDER BY id",
        [[tasks, files]],
      );
      return {
        card: await getItemInZero(card.processingProposalsDatabaseId, card.cardId),
        items: z.array(z.object({ id: z.uuid(), properties: z.record(z.string(), z.unknown()) })).parse(items.rows),
        attachments: await inZero(() =>
          withTransaction(pool, (client) => listInboxAttachments(client, [card.source.id, foreignId])),
        ),
      };
    };
    const confirm = () => api(`/api/proposals/${card.cardId}/confirm`, { method: "POST", headers });
    for (const [properties, field] of [
      [{ attachmentId: attachment.foreign, name: "Photo" }, "attachmentId"],
      [{ attachmentId: attachment.own, name: "Photo", file: { blobId: attachment.blobId } }, "file"],
      [{ attachmentId: attachment.own, name: "Photo", type: "jpg" }, "type"],
      [{ attachmentId: attachment.own, name: "Photo", untrusted: true }, "untrusted"],
    ] as const) {
      await store(properties);
      const before = await snapshot();
      await expectError(await confirm(), 400, { code: "validation_failed", details: { ref: "file", field } });
      expect(await snapshot()).toEqual(before);
    }
    await store({ attachmentId: attachment.own, name: "Photo" });
    const success = await confirm();
    expect(success.status).toBe(200);
    expect(
      z.object({ properties: z.object({ status: z.string(), resultItemId: z.uuid() }) }).parse(await success.json())
        .properties.status,
    ).toBe("confirmed");
    const after = await snapshot();
    expect(after.attachments.map((item) => item.attachmentId)).toEqual([attachment.foreign]);
    const fileBlob = z.object({ file: z.object({ blobId: z.uuid() }).optional() });
    expect(after.items.some((item) => fileBlob.parse(item.properties).file?.blobId === attachment.blobId)).toBe(true);
  });

  it("projects confirmed Inbox origin through item, database and view HTTP reads", async () => {
    await seed();
    const headers = await jsonAuth();
    const filesId = (await moduleDatabase("files")).id;
    const companiesId = (await moduleDatabase("companies")).id;
    const peopleId = (await moduleDatabase("people")).id;
    // The Files editor schema requires the file, so the card carries a blob that exists.
    const blob = await inZero(() =>
      withTransaction(pool, (client) =>
        createBlob(client, { mimeType: "application/pdf", byteSize: 12, storageKey: `blobs/${randomUUID()}` }),
      ),
    );
    const card = await proposalCard(
      { name: "File", emoji: "📄", processingMethod: "database", targetDatabase: "files" },
      "A file",
      { name: "From Inbox", file: { blobId: blob.id } },
    );
    const viewId = (
      await inZero(() => chokePoint.createView({ databaseId: filesId, type: "list", name: "Files", config: {} }))
    ).id;
    const readCard = () => getItemInZero(card.processingProposalsDatabaseId, card.cardId);
    const originalCard = await readCard();
    if (!originalCard) throw new Error("Missing proposal card");
    const counts = async () => ({
      targets: (
        await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM items WHERE database_id = ANY($1::uuid[])",
          [[companiesId, peopleId]],
        )
      ).rows,
      edges: (await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM item_relations")).rows,
    });
    const originalCounts = await counts();
    const company = {
      ref: "company",
      op: "create",
      databaseKey: "companies",
      role: "primary",
      properties: { name: "Acme" },
    };
    for (const [properties, field] of [
      [{ name: "Jane", bogus: 1 }, "bogus"],
      [{ name: 42 }, "name"],
    ] as const) {
      const person = {
        ref: "person",
        op: "create",
        databaseKey: "people",
        role: "secondary",
        properties,
        relations: { companies: [{ ref: "company" }] },
      };
      await storeProposal(card.processingProposalsDatabaseId, card.cardId, {
        entityKind: "database",
        target: companiesId,
        properties: company.properties,
        operations: [company, person],
      });
      const before = await readCard();
      const failure = await confirmProposal(card.cardId, headers);
      expect(failure.status).toBe(400);
      expect(
        z
          .object({ error: z.object({ details: z.object({ ref: z.string(), field: z.string() }) }) })
          .parse(await failure.json()).error.details,
      ).toEqual({ ref: "person", field });
      const after = await readCard();
      expect(after).toEqual(before);
      expect(after?.properties.status).toBe("proposed");
      expect(await counts()).toEqual(originalCounts);
    }
    await storeProposal(card.processingProposalsDatabaseId, card.cardId, {
      entityKind: "someFutureKind",
      target: companiesId,
      properties: { name: "Future" },
    });
    const futureBefore = await readCard();
    const unsupported = await confirmProposal(card.cardId, headers);
    expect(unsupported.status).toBe(409);
    expect(httpError.parse(await unsupported.json()).error).toEqual({
      code: "version_conflict",
      details: { field: "entityKind", entityKind: "someFutureKind" },
    });
    expect(await readCard()).toEqual(futureBefore);
    expect(futureBefore?.properties.status).toBe("proposed");
    expect(await counts()).toEqual(originalCounts);
    await storeProposal(card.processingProposalsDatabaseId, card.cardId, originalCard.properties.proposal);
    const confirmed = await confirmProposal(card.cardId, headers);
    expect(confirmed.status).toBe(200);
    const resultId = z.object({ properties: z.object({ resultItemId: z.string() }) }).parse(await confirmed.json())
      .properties.resultItemId;
    const manual = await createIn(filesId, headers, { properties: { name: "Manual" } });
    expect(manual.status).toBe(201);
    const manualBody = z.object({ id: z.string(), fromInbox: z.boolean().optional() }).parse(await manual.json());
    expect(manualBody.fromInbox).toBeUndefined();
    const schema = z.object({ id: z.string(), fromInbox: z.boolean() });
    for (const [id, expected] of [
      [resultId, true],
      [manualBody.id, false],
    ] as const) {
      const response = await api(`/api/items/${id}`, { headers });
      expect(response.status).toBe(200);
      expect(schema.parse(await response.json())).toMatchObject({ id, fromInbox: expected });
    }
    for (const response of [await queryDb(filesId, headers), await queryView(viewId, headers)]) {
      expect(response.status).toBe(200);
      const page = z.object({ items: z.array(schema) }).parse(await response.json());
      expect(Object.fromEntries(page.items.map((item) => [item.id, item.fromInbox]))).toEqual({
        [resultId]: true,
        [manualBody.id]: false,
      });
    }
  });

  it.each(["item get", "database query", "view query", "patch", "conflict"])(
    "sanitizes Emails.body on REST %s",
    async (path) => {
      await seed();
      const headers = await jsonAuth();
      const raw = '<p onclick="evil()">safe</p><script>evil()</script><img src="https://tracker.example/pixel">';
      const emails = await moduleDatabase("emails");
      const item = await withTransaction(pool, (client) =>
        createItemWithClient(
          client,
          { databaseId: emails.id, properties: { body: raw } },
          { allowedSystemKeys: ["body"] },
        ),
      );
      let response: Response;
      if (path === "database query") response = await queryDb(item.databaseId, headers);
      else if (path === "view query") {
        const view = await chokePoint.createView({
          databaseId: item.databaseId,
          type: "list",
          name: "Projection test",
          config: {},
        });
        response = await queryView(view.id, headers);
      } else if (path === "item get") response = await api(`/api/items/${item.id}`, { headers });
      else
        response = await patchItem(
          item.id,
          headers,
          { read: true },
          path === "conflict" ? "2000-01-01T00:00:00.000Z" : item.version,
        );
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

  async function makeMovie(title = "Dune") {
    const db = await makeMoviesDb();
    return { db, item: await chokePoint.createItem({ databaseId: db.id, properties: { title } }) };
  }

  /** A row inside an inline database of a row inside an inline database of a top-level row. */
  async function makeNestedRows() {
    const rootDb = await chokePoint.createDatabase({ name: "Root" });
    const rootItem = await chokePoint.createItem({ databaseId: rootDb.id, properties: {} });
    const midDb = await chokePoint.createInlineDatabase({ name: "Mid", parentItemId: rootItem.id });
    const midItem = await chokePoint.createItem({ databaseId: midDb.id, properties: {} });
    const leafDb = await chokePoint.createInlineDatabase({ name: "Leaf", parentItemId: midItem.id });
    const leafItem = await chokePoint.createItem({ databaseId: leafDb.id, properties: {} });
    return { rootItem, midDb, midItem, leafItem };
  }

  const anyId = randomUUID();
  it.each([
    ["POST", `/api/databases/${anyId}/items`],
    ["GET", `/api/items/${anyId}`],
    ["PATCH", `/api/items/${anyId}`],
    ["DELETE", `/api/items/${anyId}`],
    ["POST", `/api/items/${anyId}/restore`],
    ["POST", `/api/databases/${anyId}/query`],
    ["PUT", `/api/items/${anyId}/relations/foo/${anyId}`],
    ["DELETE", `/api/items/${anyId}/relations/foo/${anyId}`],
    ["GET", `/api/items/${anyId}/relations`],
    ["GET", `/api/items/${anyId}/related`],
    ["GET", `/api/items/${anyId}/delete-impact`],
    ["POST", `/api/items/${anyId}/page/restore`],
  ])("rejects an unauthenticated %s %s", async (method, path) => {
    expect((await api(path, { method })).status).toBe(401);
  });

  it.each([
    ["GET", `/api/items/${anyId}`],
    ["GET", `/api/items/${anyId}?include=path`],
    ["GET", `/api/items/${anyId}?include=path,links`],
    ["DELETE", `/api/items/${anyId}`],
    ["POST", `/api/items/${anyId}/restore`],
    ["POST", `/api/databases/${anyId}/query`],
    ["PUT", `/api/items/${anyId}/relations/foo/${anyId}`],
    ["GET", `/api/items/${anyId}/relations`],
    ["GET", `/api/items/${anyId}/related`],
  ])("answers %s %s for an unknown id with 404", async (method, path) => {
    const res = await api(path, { method, headers: await authHeader() });
    expect(res.status).toBe(404);
    if (method === "GET" && path.includes("relat"))
      expect(((await res.json()) as ErrorBody).error.code).toBe("not_found");
  });

  describe("create", () => {
    it("creates initial relations atomically and replays the idempotency key over REST", async () => {
      const headers = { ...(await jsonAuth()), "Idempotency-Key": randomUUID() };
      const f = await inZero(async () => {
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
        createIn(
          f.source.id,
          { ...headers, "Idempotency-Key": key },
          { properties: {}, relations: [{ propertyKey: "project", targetItemIds: [targetItemId] }] },
        );
      const idOf = async (res: Response) => {
        expect(res.status).toBe(201);
        return z.object({ id: z.uuid() }).parse(await res.json()).id;
      };
      const itemId = await idOf(await create(f.first.id));
      expect(await idOf(await create(f.second.id))).toBe(itemId);
      expect(await idOf(await create(randomUUID()))).toBe(itemId);
      expect(await inZero(() => chokePoint.listItemRelations(itemId, f.property.id))).toMatchObject([
        { targetItemId: f.first.id },
      ]);
      const count = async () =>
        (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [f.source.id]))
          .rows;
      const before = await count();
      expect((await create(randomUUID(), randomUUID())).status).toBe(400);
      expect(await count()).toEqual(before);
    });

    it.each([
      ["with", { "Idempotency-Key": randomUUID() }],
      ["without", {}],
    ])("creates an item %s an Idempotency-Key and returns 201 with the full row", async (_label, extra) => {
      const db = await makeMoviesDb();
      const res = await createIn(db.id, { ...(await jsonAuth()), ...extra }, { properties: { title: "Arrival" } });
      expect(res.status).toBe(201);
      const body = (await res.json()) as ItemBody;
      expect(body.databaseId).toBe(db.id);
      expect(body.properties).toEqual({ title: "Arrival" });
    });

    it("repeating the same Idempotency-Key returns the original row without a second insert", async () => {
      const db = await makeMoviesDb();
      const headers = { ...(await jsonAuth()), "Idempotency-Key": randomUUID() };
      const firstBody = (await (await createIn(db.id, headers, { properties: { title: "Dune" } })).json()) as ItemBody;
      const second = await createIn(db.id, headers, { properties: { title: "Dune 2" } });
      expect(second.status).toBe(201);
      const secondBody = (await second.json()) as ItemBody;
      expect(secondBody.id).toBe(firstBody.id);
      expect(secondBody.properties).toEqual({ title: "Dune" });
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [db.id]);
      expect(rows[0].n).toBe(1);
    });

    it("refuses a Journal entry posted without its type and period with 403 and stores no row", async () => {
      await seed();
      const journal = await moduleDatabase("journal");
      const headers = await jsonAuth();
      for (const payload of [{}, { properties: {} }]) {
        const res = await createIn(journal.id, { ...headers, "Idempotency-Key": randomUUID() }, payload);
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

  it.each(["create", "patch", "delete", "restore"] as const)(
    "rejects a %s against an archived database with 403 database_archived",
    async (operation) => {
      const { db, item } = await makeMovie();
      const headers = await jsonAuth();
      if (operation === "restore") await api(`/api/items/${item.id}`, { method: "DELETE", headers });
      await chokePoint.archiveDatabase(db.id);
      const res = await {
        create: () =>
          createIn(db.id, { ...headers, "Idempotency-Key": randomUUID() }, { properties: { title: "Arrival" } }),
        patch: () => patchItem(item.id, headers, { title: "Dune (2021)" }, item.version),
        delete: () => api(`/api/items/${item.id}`, { method: "DELETE", headers }),
        restore: () => api(`/api/items/${item.id}/restore`, { method: "POST", headers }),
      }[operation]();
      await expectError(res, 403, { code: "database_archived" });
    },
  );

  describe("detail", () => {
    it("returns 400 validation_failed naming 'id' for a non-UUID item id", async () => {
      await expectValidation(await api("/api/items/foo", { headers: await authHeader() }), "id");
    });

    it("returns a top-level row without a path by default and with a single-entry path on request", async () => {
      const { item } = await makeMovie();
      const headers = await authHeader();
      const plain = await api(`/api/items/${item.id}`, { headers });
      expect(plain.status).toBe(200);
      const plainBody = (await plain.json()) as ItemBody;
      expect(plainBody.id).toBe(item.id);
      expect(plainBody.path).toBeUndefined();
      const withPath = (await (await api(`/api/items/${item.id}?include=path`, { headers })).json()) as ItemBody;
      expect(withPath.path?.map((i) => i.id)).toEqual([item.id]);
    });

    it("assembles the full ancestor chain for a row nested several inline databases deep", async () => {
      const headers = await authHeader();
      const { rootItem, midItem, leafItem } = await makeNestedRows();
      const res = await api(`/api/items/${leafItem.id}?include=path`, { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ItemBody;
      expect(body.path?.map((i) => i.id)).toEqual([rootItem.id, midItem.id, leafItem.id]);
    });
  });

  describe("patch", () => {
    it("merges a properties patch by key and returns 200 with the full row", async () => {
      const db = await chokePoint.createDatabase({ name: "D" });
      await chokePoint.createProperty({ databaseId: db.id, key: "title", name: "Title", type: "text" });
      await chokePoint.createProperty({ databaseId: db.id, key: "year", name: "Year", type: "number" });
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune", year: 2021 } });
      const res = await patchItem(item.id, await jsonAuth(), { title: "Dune (2021)" }, item.version);
      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      expect(body).toEqual({
        id: item.id,
        databaseId: db.id,
        properties: { title: "Dune (2021)", year: 2021 },
        computed: item.computed,
        // The patch leaves the creation time unchanged.
        createdAt: item.createdAt,
        updatedAt: expect.any(String),
        deletedAt: null,
        version: String(Number(item.version) + 1),
      });
      expect(body).not.toHaveProperty("previous");
    });

    it("rejects a patch body with no properties field", async () => {
      const { item } = await makeMovie();
      const res = await api(`/api/items/${item.id}`, req("PATCH", await jsonAuth(), { ifVersion: item.version }));
      await expectError(res, 400, { code: "validation_failed" });
    });

    it("writes a REST PATCH as the user writer", async () => {
      const { item } = await makeMovie();
      const headers = await jsonAuth();
      const writers: WriterIdentity[] = [];
      // Hooks cannot be unregistered; this recorder only appends to this test's array.
      registerItemUpdateHook(async (context) => {
        writers.push(context.writer);
      });
      expect((await patchItem(item.id, headers, { title: "Dune: Part Two" }, item.version)).status).toBe(200);
      expect(writers).toEqual([{ writerKind: "user" }]);
    });

    it("rejects caller-supplied writerKind on create and patch without writing", async () => {
      const { db, item } = await makeMovie();
      const headers = await jsonAuth();
      const created: WriterIdentity[] = [];
      const updated: WriterIdentity[] = [];
      // Hooks cannot be unregistered; these recorders only append to this test's arrays.
      registerItemCreateHook(async (context) => {
        created.push(context.writer);
      });
      registerItemUpdateHook(async (context) => {
        updated.push(context.writer);
      });
      const patch = await api(
        `/api/items/${item.id}`,
        req("PATCH", headers, { properties: { title: "Changed" }, ifVersion: item.version, writerKind: "system" }),
      );
      const create = await createIn(db.id, headers, { properties: { title: "New" }, writerKind: "system" });
      for (const res of [patch, create]) {
        await expectError(res, 400, { code: "validation_failed", details: { field: "writerKind" } });
      }
      expect(updated).toEqual([]);
      expect(created).toEqual([]);
      expect((await chokePoint.getItem(db.id, item.id))?.properties).toEqual({ title: "Dune" });
    });

    it("returns 404 patching an unknown item", async () => {
      const res = await patchItem(randomUUID(), await jsonAuth(), {}, new Date().toISOString());
      expect(res.status).toBe(404);
    });

    it("returns 409 version_conflict with details.currentItem on a stale ifVersion", async () => {
      const { item } = await makeMovie();
      const headers = await jsonAuth();
      await patchItem(item.id, headers, { title: "Dune (2021)" }, item.version);
      const res = await patchItem(item.id, headers, { title: "Dune Part Two" }, item.version);
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
      const res = await patchItem(item.id, await jsonAuth(), { [rollup.key]: 5 }, item.version);
      await expectError(res, 403, { code: "computed_readonly" });
    });
  });

  describe("delete and restore", () => {
    it("soft-deletes and restores an item idempotently, returning 200 with the full row each time", async () => {
      const { item } = await makeMovie();
      const headers = await authHeader();
      for (const [method, path, deleted] of [
        ["DELETE", `/api/items/${item.id}`, true],
        ["DELETE", `/api/items/${item.id}`, true],
        ["POST", `/api/items/${item.id}/restore`, false],
        ["POST", `/api/items/${item.id}/restore`, false],
      ] as const) {
        const res = await api(path, { method, headers });
        expect(res.status).toBe(200);
        const body = (await res.json()) as ItemBody;
        expect(body.id).toBe(item.id);
        expect(body.deletedAt === null).toBe(!deleted);
      }
    });

    it("cascades the delete and the restore through nested inline databases", async () => {
      const headers = await authHeader();
      const { rootItem, midDb, midItem } = await makeNestedRows();
      expect((await api(`/api/items/${rootItem.id}`, { method: "DELETE", headers })).status).toBe(200);
      expect((await chokePoint.getItem(midDb.id, midItem.id))?.deletedAt).not.toBeNull();
      expect((await api(`/api/items/${rootItem.id}/restore`, { method: "POST", headers })).status).toBe(200);
      expect((await chokePoint.getItem(midDb.id, midItem.id))?.deletedAt).toBeNull();
    });
  });

  describe("query database", () => {
    it("returns items ordered by id by default with no body, never 204", async () => {
      const db = await makeMoviesDb();
      const a = await chokePoint.createItem({ databaseId: db.id, properties: { title: "A" } });
      const b = await chokePoint.createItem({ databaseId: db.id, properties: { title: "B" } });
      const res = await api(`/api/databases/${db.id}/query`, { method: "POST", headers: await authHeader() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ItemQueryBody;
      expect(body.items.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());
    });

    it("applies a filter tree, and excludes soft-deleted items unless inTrash is true", async () => {
      const db = await makeMoviesDb();
      const arrival = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Arrival" } });
      const dune = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      const headers = await jsonAuth();
      const ids = async (body: unknown) => {
        const res = await queryDb(db.id, headers, body);
        expect(res.status).toBe(200);
        return ((await res.json()) as ItemQueryBody).items.map((i) => i.id).sort();
      };
      expect(await ids({ filter: { type: "equals", property: "title", value: "Dune" } })).toEqual([dune.id]);
      await chokePoint.softDeleteItem(db.id, dune.id);
      expect(await ids({})).toEqual([arrival.id]);
      expect(await ids({ inTrash: true })).toEqual([arrival.id, dune.id].sort());
    });

    it("paginates with a stable, non-duplicating keyset cursor under default order", async () => {
      const db = await makeMoviesDb();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push((await chokePoint.createItem({ databaseId: db.id, properties: { title: `T${i}` } })).id);
      }
      const headers = await jsonAuth();
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page++) {
        const res = await queryDb(db.id, headers, { limit: 2, cursor: cursor ?? undefined });
        expect(res.status).toBe(200);
        const body = (await res.json()) as ItemQueryBody;
        seen.push(...body.items.map((i) => i.id));
        cursor = body.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toEqual(ids.sort());
    });

    it.each([
      ["a malformed filter tree", { filter: { type: "not_a_real_type", property: "title" } }],
      ["a malformed sort array", { sort: [{ property: "title", direction: "sideways" }] }],
      ["a non-positive limit", { limit: 0 }],
      ["a non-UUID cursor", { cursor: "not-a-uuid" }],
      ["a non-boolean inTrash", { inTrash: "yes" }],
      ["an include value the catalog does not know", { include: ["comments"] }],
    ])("returns validation_failed for %s", async (_label, body) => {
      const db = await makeMoviesDb();
      await expectError(await queryDb(db.id, await jsonAuth(), body), 400, { code: "validation_failed" });
    });

    it("matches a stored view's results and returns the same totalCount from both, and none by default", async () => {
      const db = await makeMoviesDb();
      const arrivals = [];
      for (const title of ["Arrival", "Arrival", "Arrival", "Dune"]) {
        const item = await chokePoint.createItem({ databaseId: db.id, properties: { title } });
        if (title === "Arrival") arrivals.push(item.id);
      }
      const headers = await jsonAuth();
      const filter = { type: "equals", property: "title", value: "Arrival" };
      const view = await chokePoint.createView({ databaseId: db.id, type: "table", name: "A", config: { filter } });
      const dbBody = (await (await queryDb(db.id, headers, { filter })).json()) as ItemQueryBody;
      const viewBody = (await (await queryView(view.id, headers)).json()) as ItemQueryBody;
      expect(dbBody.items.map((i) => i.id).sort()).toEqual(arrivals.sort());
      expect(viewBody.items.map((i) => i.id)).toEqual(dbBody.items.map((i) => i.id));
      expect(viewBody.nextCursor).toBe(dbBody.nextCursor);
      expect(dbBody).not.toHaveProperty("totalCount");
      const counted = (await (
        await queryDb(db.id, headers, { filter, limit: 2, includeCount: true })
      ).json()) as ItemQueryBody;
      const viewCounted = (await (
        await queryView(view.id, headers, { limit: 2, includeCount: true })
      ).json()) as ItemQueryBody;
      expect(counted.items).toHaveLength(2);
      expect(counted.totalCount).toBe(3);
      expect(viewCounted.totalCount).toBe(3);
    });

    it("returns 400 naming includeCount for a non-boolean value on both routes", async () => {
      const db = await makeMoviesDb();
      const view = await chokePoint.createView({ databaseId: db.id, type: "table", name: "V" });
      const headers = await jsonAuth();
      for (const res of [
        await queryDb(db.id, headers, { includeCount: "yes" }),
        await queryView(view.id, headers, { includeCount: "yes" }),
      ]) {
        expect(res.status).toBe(400);
        expect(JSON.stringify(((await res.json()) as ErrorBody).error)).toContain("includeCount");
      }
    });
  });

  describe("free text q", () => {
    async function makeFilms() {
      const db = await makeMoviesDb();
      await chokePoint.createProperty({
        databaseId: db.id,
        key: "stage",
        name: "Stage",
        type: "select",
        config: { options: [{ key: "todo" }, { key: "done" }] },
      });
      const make = (title: string, stage: string) =>
        chokePoint.createItem({ databaseId: db.id, properties: { title, stage } });
      return {
        db,
        arrival: await make("Příchod Novák", "todo"),
        dune: await make("Duna Novák", "done"),
        third: await make("Novák třetí", "todo"),
        other: await make("Jiný film", "todo"),
      };
    }

    const post = (path: string, headers: HeaderMap, body: unknown) =>
      api(path, req("POST", { ...headers, "Content-Type": "application/json" }, body));

    it("narrows a database query by q together with the filter and keeps totalCount at the filter-only count", async () => {
      const { db, arrival, third } = await makeFilms();
      const res = await post(`/api/databases/${db.id}/query`, await authHeader(), {
        q: "novak",
        filter: { type: "equals", property: "stage", value: "todo" },
        includeCount: true,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ItemQueryBody;
      expect(body.items.map((item) => item.id).sort()).toEqual([arrival.id, third.id].sort());
      expect(body.totalCount).toBe(3);
    });

    it("pages a q match in the requested sort order, one item per page, with the cursor", async () => {
      const { db } = await makeFilms();
      const headers = await authHeader();
      const titles: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page += 1) {
        const res = await post(`/api/databases/${db.id}/query`, headers, {
          q: "novak",
          sort: [{ property: "title", direction: "asc" }],
          limit: 1,
          ...(cursor === null ? {} : { cursor }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as ItemQueryBody;
        titles.push(...body.items.map((item) => String(item.properties.title)));
        cursor = body.nextCursor;
        if (cursor === null) break;
      }
      expect(titles).toEqual(["Duna Novák", "Novák třetí", "Příchod Novák"]);
    });

    it("answers 400 on the field q for an empty, an over-long and a non-string q, without repeating it", async () => {
      const { db } = await makeFilms();
      const headers = await authHeader();
      const tooLong = "q".repeat(201);
      for (const q of ["", tooLong, 7]) {
        const res = await post(`/api/databases/${db.id}/query`, headers, { q });
        expect(res.status).toBe(400);
        const text = await res.text();
        expect(text).toContain('"q"');
        expect(text).not.toContain(tooLong);
      }
      expect((await post(`/api/databases/${randomUUID()}/query`, {}, { q: "novak" })).status).toBe(401);
    });

    it("counts per entry only the rows q matches, ANDed with the filter, and 400s an invalid q on its entry", async () => {
      const { db } = await makeFilms();
      const headers = await authHeader();
      const res = await post("/api/items/count", headers, {
        items: [
          { databaseId: db.id },
          { databaseId: db.id, q: "novak" },
          { databaseId: db.id, q: "novak", filter: { type: "equals", property: "stage", value: "todo" } },
          { databaseId: db.id, q: "(novak & | ! : ')", groupBy: "stage" },
        ],
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        counts: [
          { databaseId: db.id, count: 4 },
          { databaseId: db.id, count: 3 },
          { databaseId: db.id, count: 2 },
          {
            databaseId: db.id,
            count: 3,
            groups: [
              { key: "todo", count: 2 },
              { key: "done", count: 1 },
            ],
          },
        ],
      });
      const marker = "zzmarkerzz".repeat(30);
      const refused = await post("/api/items/count", headers, {
        items: [{ databaseId: db.id }, { databaseId: db.id, q: marker }],
      });
      expect(refused.status).toBe(400);
      const text = await refused.text();
      expect(text).toContain("items.1.q");
      expect(text).not.toContain(marker);
    });
  });

  /** What the database query answers for this database id and body, which count and facets must repeat. */
  async function queryAnswer(databaseId: string, headers: HeaderMap, body: unknown, status: number): Promise<unknown> {
    const query = await queryDb(databaseId, { ...headers, "Content-Type": "application/json" }, body);
    expect(query.status).toBe(status);
    return query.json();
  }

  describe("count items", () => {
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

    const postCount = (headers: HeaderMap, body: unknown) =>
      api("/api/items/count", req("POST", { ...headers, "Content-Type": "application/json" }, body));

    it("rejects an unauthenticated request", async () => {
      expect((await postCount({}, { items: [{ databaseId: randomUUID() }] })).status).toBe(401);
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
      const { db: other } = await makeMovie();
      for (const properties of [
        { title: "A", stage: "done" },
        { title: "B", stage: "todo" },
        { title: "C", stage: "done" },
        { title: "D" },
      ]) {
        await chokePoint.createItem({ databaseId: db.id, properties });
      }
      const res = await postCount(await authHeader(), {
        items: [
          { databaseId: other.id },
          { databaseId: db.id, groupBy: "stage" },
          { databaseId: db.id, filter: { type: "not_equals", property: "title", value: "A" }, groupBy: "stage" },
        ],
      });
      expect(res.status).toBe(200);
      const groups = (todo: number, done: number) => [
        { key: "todo", count: todo },
        { key: "done", count: done },
        { key: null, count: 1 },
      ];
      expect(countsBody.parse(await res.json())).toEqual({
        counts: [
          { databaseId: other.id, count: 1 },
          { databaseId: db.id, count: 4, groups: groups(1, 2) },
          { databaseId: db.id, count: 3, groups: groups(1, 1) },
        ],
      });
    });

    it("applies the collection filter the module registry declares, through the real composition root", async () => {
      await seed();
      const projects = await moduleDatabase("projects");
      const systemProjects = (await chokePoint.listItems(projects.id, { limit: 200 })).items.length;
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

    it("returns 400 for more than 20 entries, for none, and naming groupBy for a property that cannot group", async () => {
      const db = await makeMoviesDb();
      const headers = await authHeader();
      for (const length of [21, 0]) {
        await expectValidation(
          await postCount(headers, { items: Array.from({ length }, () => ({ databaseId: db.id })) }),
          "items",
        );
      }
      const allowed = await postCount(headers, { items: Array.from({ length: 20 }, () => ({ databaseId: db.id })) });
      expect(allowed.status).toBe(200);
      expect(countsBody.parse(await allowed.json()).counts).toHaveLength(20);
      for (const groupBy of ["title", "missing"]) {
        await expectValidation(await postCount(headers, { items: [{ databaseId: db.id, groupBy }] }), "groupBy");
      }
    });

    it.each([
      ["a missing items list", {}, "items"],
      ["an unknown body key", { items: [], inTrash: true }, "inTrash"],
      ["a malformed database id", { items: [{ databaseId: "not-a-uuid" }] }, "items.0.databaseId"],
      ["an unknown entry key", { items: [{ databaseId: randomUUID(), inTrash: true }] }, "items.0"],
    ])("returns 400 for %s", async (_name, body, field) => {
      await expectValidation(await postCount(await authHeader(), body), field);
    });

    it("refuses a non-object body, a malformed filter and an unknown database exactly as the database query does", async () => {
      const db = await makeMoviesDb();
      const headers = await authHeader();
      await expectError(await postCount(headers, [{ databaseId: randomUUID() }]), 400, { code: "validation_failed" });
      for (const filter of [{ type: "nope" }, { type: "relation_path_contains", path: ["only"], value: "x" }]) {
        const expected = await queryAnswer(db.id, headers, { filter }, 400);
        const res = await postCount(headers, { items: [{ databaseId: db.id, filter }] });
        expect(res.status).toBe(400);
        expect(await res.json(), JSON.stringify(filter)).toEqual(expected);
      }
      const unknown = randomUUID();
      const expected = await queryAnswer(unknown, headers, {}, 404);
      expect(expected).toEqual({
        error: { code: "not_found", details: { resource: "database", databaseId: unknown } },
      });
      for (const items of [[{ databaseId: unknown }], [{ databaseId: db.id }, { databaseId: unknown }]]) {
        const res = await postCount(headers, { items });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(expected);
      }
    });
  });

  describe("database facets", () => {
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

    const postFacets = (headers: HeaderMap, databaseId: string, body: unknown) =>
      api(`/api/databases/${databaseId}/facets`, req("POST", { ...headers, "Content-Type": "application/json" }, body));

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
      expect((await postFacets({}, randomUUID(), { facets: ["status"] })).status).toBe(401);
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
          // The urgent cards: A (done) and B (to do).
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
          {
            property: "urgent",
            all: 2,
            open: 1,
            values: [
              { value: true, count: 1 },
              { value: false, count: 1 },
            ],
          },
          { property: "title", all: 1, open: 1, values: [{ value: "A", count: 1 }] },
        ],
      });
    });

    it("lists every status of Projects of a company in the user's language, and the counted companies for the company facet, through the real composition root", async () => {
      await seed();
      const projects = await moduleDatabase("projects");
      const companies = await moduleDatabase("companies");
      const work = await chokePoint.createItem({ databaseId: companies.id, properties: { name: "Work" } });
      const home = await chokePoint.createItem({ databaseId: companies.id, properties: { name: "Home" } });
      const companyProperty = await propertyOf(projects.id, "company");
      for (const [name, status, company] of [
        ["Launch", "inProgress", work],
        ["Audit", "done", work],
        ["Garden", "inProgress", home],
      ] as const) {
        const project = await chokePoint.createItem({ databaseId: projects.id, properties: { name, status } });
        // Projects.company sources a link rule whose propagation is queued in the writer's tenant.
        await inZero(() =>
          chokePoint.createRelation({
            relationPropertyId: companyProperty.id,
            callerItemId: project.id,
            targetItemId: company.id,
          }),
        );
      }
      const inProgress = { type: "equals", property: "status", value: "inProgress" };
      const res = await postFacets(await authHeader(), projects.id, {
        filter: {
          type: "and",
          nodes: [
            { type: "is_empty", property: "systemActive" },
            inProgress,
            { type: "relation_contains", property: "company", value: work.id },
          ],
        },
        facets: ["status", "company"],
        extra: { open: inProgress },
      });
      expect(res.status).toBe(200);
      const companyChoice = (company: typeof work) => ({
        value: company.id,
        label: String(company.properties.name),
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
            property: "company",
            all: 2,
            open: 2,
            values: [
              ...(work.id < home.id ? [work, home] : [home, work]).map(companyChoice),
              { value: null, count: 0 },
            ],
          },
        ],
      });
    });

    it("gives a Projects facet value the project's own color through the real composition root", async () => {
      await seed();
      const tasks = await moduleDatabase("tasks");
      const projects = await moduleDatabase("projects");
      const colored = await chokePoint.createItem({
        databaseId: projects.id,
        properties: { name: "Colored", color: "#FF2D55" },
      });
      const plain = await chokePoint.createItem({ databaseId: projects.id, properties: { name: "Plain" } });
      const projectProperty = await propertyOf(tasks.id, "project");
      for (const [name, project] of [
        ["First", colored],
        ["Second", colored],
        ["Third", plain],
      ] as const) {
        const task = await chokePoint.createItem({ databaseId: tasks.id, properties: { name } });
        await inZero(() =>
          chokePoint.createRelation({
            relationPropertyId: projectProperty.id,
            callerItemId: task.id,
            targetItemId: project.id,
          }),
        );
      }
      const res = await postFacets(await authHeader(), tasks.id, { facets: ["project"] });
      expect(res.status).toBe(200);
      expect(facetsBody.parse(await res.json()).facets).toEqual([
        {
          property: "project",
          all: 3,
          values: [
            { value: colored.id, label: "Colored", color: "#FF2D55", count: 2 },
            { value: plain.id, label: "Plain", count: 1 },
            { value: null, count: 0 },
          ],
        },
      ]);
    });

    it("labels the options in English for a user whose locale is en", async () => {
      await seed();
      const projects = await moduleDatabase("projects");
      const res = await postFacets(await authHeader("en"), projects.id, {
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
        await expectValidation(await postFacets(headers, db.id, { filter, facets: ["title", "stage"] }), "filter");
        expect((await postFacets(headers, db.id, { filter, facets: ["title"] })).status, filter.type).toBe(200);
      }
    });

    it("returns 400 naming facets for more than 20, none, an unknown key, a property that cannot be a facet and an unresolvable path", async () => {
      const db = await makeBoard();
      await chokePoint.createProperty({ databaseId: db.id, key: "note", name: "Note", type: "longText" });
      const headers = await authHeader();
      for (const facets of [
        Array.from({ length: 21 }, () => "stage"),
        [],
        ["missing"],
        ["note"],
        [{ path: ["stage", "title"] }],
      ]) {
        await expectValidation(await postFacets(headers, db.id, { facets }), "facets");
      }
      const allowed = await postFacets(headers, db.id, { facets: Array.from({ length: 20 }, () => "stage") });
      expect(allowed.status).toBe(200);
      expect(facetsBody.parse(await allowed.json()).facets).toHaveLength(20);
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
      await expectValidation(await postFacets(await authHeader(), db.id, body), field);
    });

    it("refuses a non-object body, a malformed filter, a non-UUID and an unknown database exactly as the database query does", async () => {
      const db = await makeBoard();
      const headers = await authHeader();
      await expectError(await postFacets(headers, db.id, ["stage"]), 400, { code: "validation_failed" });
      for (const filter of [{ type: "nope" }, { type: "relation_path_contains", path: ["only"], value: "x" }]) {
        const expected = await queryAnswer(db.id, headers, { filter }, 400);
        for (const body of [
          { facets: ["stage"], filter },
          { facets: ["stage"], extra: { open: filter } },
        ]) {
          const res = await postFacets(headers, db.id, body);
          expect(res.status).toBe(400);
          expect(await res.json(), JSON.stringify(body)).toEqual(expected);
        }
      }
      const malformed = await queryAnswer("not-a-uuid", headers, {}, 400);
      const res = await postFacets(headers, "not-a-uuid", { facets: ["stage"] });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(malformed);
      const unknown = randomUUID();
      const missing = await queryAnswer(unknown, headers, {}, 404);
      expect(missing).toEqual({ error: { code: "not_found", details: { resource: "database", databaseId: unknown } } });
      for (const body of [
        { facets: ["stage"] },
        { facets: [{ path: ["project", "company"] }], extra: { open: { type: "is_empty", property: "title" } } },
      ]) {
        const answer = await postFacets(headers, unknown, body);
        expect(answer.status).toBe(404);
        expect(await answer.json()).toEqual(missing);
      }
    });
  });

  describe("include=links", () => {
    /** Written through the store because no product code writes links yet. */
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
      return { filesDb, task, file, plain };
    }

    const readItem = async (id: string, headers: HeaderMap, query = "?include=links") =>
      (await (await api(`/api/items/${id}${query}`, { headers })).json()) as ItemBody;

    it("breaks a linked plain value through a user REST patch", async () => {
      const { filesDb, file } = await makeLinkedFile();
      await chokePoint.createProperty({ databaseId: filesDb.id, key: "note", name: "Note", type: "text" });
      await withTransaction(pool, (client) =>
        insertValueLink(client, { itemId: file.id, propertyKey: "note", ruleKey: "test", sources: [] }),
      );
      const headers = await jsonAuth();
      expect((await patchItem(file.id, headers, { note: "changed" }, file.version)).status).toBe(200);
      expect(await readItem(file.id, headers)).toMatchObject({
        properties: { note: "changed" },
        links: { note: { valueKind: "inheritedBroken", brokenBy: "user" } },
      });
    });

    it("returns links.projects with the inherited kind and the source including its title", async () => {
      const { file, task } = await makeLinkedFile();
      const res = await api(`/api/items/${file.id}?include=links`, { headers: await authHeader() });
      expect(res.status).toBe(200);
      expect(((await res.json()) as ItemBody).links).toEqual({
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
      const entry = (await readItem(file.id, await authHeader())).links?.projects as { sources: { title: string }[] };
      expect(entry.sources.map((source) => source.title).sort()).toEqual(["Pay the invoice", "Send the invoice"]);
    });

    it("reads a broken row as inheritedBroken with brokenBy and brokenAt", async () => {
      const { file } = await makeLinkedFile({ broken: true });
      expect((await readItem(file.id, await authHeader())).links?.projects).toMatchObject({
        valueKind: "inheritedBroken",
        brokenBy: "user",
        brokenAt: "2026-10-20T10:00:00.000Z",
      });
    });

    it("returns links and path only as include asks", async () => {
      const { plain, file } = await makeLinkedFile();
      const headers = await authHeader();
      expect((await readItem(plain.id, headers)).links).toEqual({});
      expect("links" in (await readItem(file.id, headers, ""))).toBe(false);
      const both = await readItem(file.id, headers, "?include=path,links");
      expect(both.path?.map((item) => item.id)).toEqual([file.id]);
      expect(Object.keys(both.links ?? {})).toEqual(["projects"]);
      const pathOnly = await readItem(file.id, headers, "?include=path");
      expect(pathOnly.path).toHaveLength(1);
      expect("links" in pathOnly).toBe(false);
    });

    it("gives each item of a database or view query page its own links, and none without include", async () => {
      const { filesDb, file, plain } = await makeLinkedFile();
      const headers = await jsonAuth();
      const view = await chokePoint.createView({
        databaseId: filesDb.id,
        type: "table",
        name: "All files",
        config: {},
      });
      for (const res of [
        await queryDb(filesDb.id, headers, { include: ["links"] }),
        await queryView(view.id, headers, { include: ["links"] }),
      ]) {
        expect(res.status).toBe(200);
        const byId = new Map(((await res.json()) as ItemQueryBody).items.map((item) => [item.id, item]));
        expect(Object.keys(byId.get(file.id)?.links ?? {})).toEqual(["projects"]);
        expect(byId.get(plain.id)?.links).toEqual({});
      }
      const plainPage = (await (await queryDb(filesDb.id, headers)).json()) as ItemQueryBody;
      expect(plainPage.items.every((item) => !("links" in item))).toBe(true);
    });

    it("returns the production fileCompaniesFromProjects link with both project sources through runtime HTTP, and nothing to another tenant", async () => {
      await seed();
      const headers = await authHeader();
      const foreignHeaders = await authHeader();
      await withRuntimeServer(async (runtime, base) => {
        // The link comes from the manifest's rule.
        const f = await inZero(async () => {
          const cp = createChokePoint(runtime);
          const db = async (key: string) => (await moduleDatabase(key, runtime)).id;
          const create = async (databaseKey: string, name: string) =>
            (await cp.createItem({ databaseId: await db(databaseKey), properties: { name } })).id;
          const relate = async (databaseKey: string, key: string, callerItemId: string, targetItemId: string) =>
            cp.createRelation(
              { relationPropertyId: (await propertyOf(await db(databaseKey), key, cp)).id, callerItemId, targetItemId },
              { writerKind: "user" },
            );
          const novak = await create("companies", "Novak Web s.r.o.");
          const siko = await create("companies", "Siko Koupelny a.s.");
          const web = await create("projects", "Web for client");
          const bathroom = await create("projects", "Bathroom renovation");
          const file = await create("files", "Contract");
          await relate("projects", "company", web, novak);
          await relate("projects", "company", bathroom, siko);
          await relate("files", "projects", file, web);
          await relate("files", "projects", file, bathroom);
          return { novak, siko, web, bathroom, file };
        });
        const byItem = (a: { itemId: string }, b: { itemId: string }) => a.itemId.localeCompare(b.itemId);
        const read = await fetch(`${base}/api/items/${f.file}?include=links`, { headers });
        expect(read.status).toBe(200);
        const companies = itemLinkEntry.parse(linkedItemBody.parse(await read.json()).links.companies);
        const source = (itemId: string, title: string) => ({
          kind: "item",
          itemId,
          databaseKey: "projects",
          title,
          propertyKey: "company",
        });
        expect({ ...companies, sources: [...companies.sources].sort(byItem) }).toEqual({
          valueKind: "inherited",
          sources: [source(f.web, "Web for client"), source(f.bathroom, "Bathroom renovation")].sort(byItem),
          brokenBy: null,
          brokenAt: null,
        });
        const listed = await fetch(`${base}/api/items/${f.file}/relations?propertyKey=companies`, { headers });
        expect(listed.status).toBe(200);
        const targets = relationTargets.parse(await listed.json()).relations.map((entry) => entry.targetItemId);
        expect(targets.sort()).toEqual([f.novak, f.siko].sort());
        await expectForeignLikeMissing(
          (id) => fetch(`${base}/api/items/${id}?include=links`, { headers: foreignHeaders }),
          f.file,
        );
      });
    });
  });

  describe("relations", () => {
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
      const task = await chokePoint.createItem({ databaseId: source.id, properties: {} });
      const person = await chokePoint.createItem({ databaseId: target.id, properties: {} });
      return { source, target, property, inverseProperty, task, person };
    }

    const relation = (method: string, item: string, key: string, target: string, headers: HeaderMap, body?: unknown) =>
      api(`/api/items/${item}/relations/${key}/${target}`, req(method, headers, body));

    it("returns 400 validation_failed naming 'targetItemId' for a non-UUID target item id", async () => {
      const res = await api(`/api/items/${randomUUID()}/relations/exampleKey/foo`, {
        method: "PUT",
        headers: await authHeader(),
      });
      await expectValidation(res, "targetItemId");
    });

    it("returns 404 for a propertyKey that is not a relation of the caller's database", async () => {
      const { source, task } = await makePairedRelation();
      const other = await chokePoint.createDatabase({ name: "Other" });
      await chokePoint.createProperty({ databaseId: other.id, key: "unrelated", name: "Unrelated", type: "text" });
      await chokePoint.createProperty({ databaseId: source.id, key: "notes", name: "Notes", type: "text" });
      const headers = await authHeader();
      for (const [method, key] of [
        ["PUT", "nope"],
        ["PUT", "unrelated"],
        ["DELETE", "nope"],
      ] as const) {
        expect((await relation(method, task.id, key, randomUUID(), headers)).status, `${method} ${key}`).toBe(404);
      }
      const res = await relation("PUT", task.id, "notes", randomUUID(), headers);
      expect(res.status).toBe(404);
      expect(((await res.json()) as ErrorBody).error).toEqual({
        code: "not_found",
        details: { resource: "relationProperty", databaseId: source.id, propertyKey: "notes" },
      });
    });

    it("creates an edge from either side with the same normalized envelope, replaces metadata, and deletes it", async () => {
      const { property, inverseProperty, task, person } = await makePairedRelation();
      const headers = await jsonAuth();
      expect((await relation("DELETE", task.id, property.key, person.id, headers)).status).toBe(404);
      const direct = await relation("PUT", task.id, property.key, person.id, headers, {
        metadata: { role: "owner", note: "x" },
      });
      expect(direct.status).toBe(200);
      const directBody = (await direct.json()) as RelationBody;
      expect(directBody).toMatchObject({ itemA: task.id, itemB: person.id, metadata: { role: "owner", note: "x" } });
      const inverse = await relation("PUT", person.id, inverseProperty.key, task.id, headers, {
        metadata: { role: "reviewer" },
      });
      expect(inverse.status).toBe(200);
      const inverseBody = (await inverse.json()) as RelationBody;
      expect(inverseBody).toMatchObject({ id: directBody.id, itemA: task.id, itemB: person.id });
      expect(inverseBody.metadata).toEqual({ role: "reviewer" });
      const removed = await relation("DELETE", task.id, property.key, person.id, headers);
      expect(removed.status).toBe(200);
      expect(await removed.json()).toEqual(inverseBody);
    });

    it("attributes a linked relation invalidation to the authenticated REST user", async () => {
      const { property, task, person } = await makePairedRelation();
      await withTransaction(pool, (client) =>
        insertValueLink(client, { itemId: task.id, propertyKey: property.key, ruleKey: "test", sources: [] }),
      );
      const user = await createUser(pool, {
        tenantId: await tenantForNextTestUser(pool),
        email: `${randomUUID()}@example.com`,
        passwordHash: await hashPassword(PASSWORD),
      });
      const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        expect(
          (await relation("PUT", task.id, property.key, person.id, { Authorization: `Bearer ${token}` })).status,
        ).toBe(200);
        expect(events.filter((event) => event.scope === "item" && event.itemId === task.id)).toEqual([
          expect.objectContaining({ userId: user.id }),
        ]);
      } finally {
        setInvalidationHook(() => {});
      }
    });

    it("enforces one_to_one cardinality with 409 cardinality_violation", async () => {
      const { source, property, person } = await makePairedRelation("one_to_one");
      const [taskA, taskB] = [
        await chokePoint.createItem({ databaseId: source.id, properties: {} }),
        await chokePoint.createItem({ databaseId: source.id, properties: {} }),
      ];
      const headers = await jsonAuth();
      await relation("PUT", taskA.id, property.key, person.id, headers);
      await expectError(await relation("PUT", taskB.id, property.key, person.id, headers), 409, {
        code: "cardinality_violation",
      });
    });

    it.each([
      ["one_to_many", "a single source item to many targets", "target"],
      ["many_to_many", "many source items to one target", "source"],
    ] as const)("allows %s: %s", async (cardinality, _label, side) => {
      const { source, target, property, task, person } = await makePairedRelation(cardinality);
      const headers = await jsonAuth();
      const extra = await chokePoint.createItem({
        databaseId: side === "target" ? target.id : source.id,
        properties: {},
      });
      expect((await relation("PUT", task.id, property.key, person.id, headers)).status).toBe(200);
      const [caller, target2] = side === "target" ? [task.id, extra.id] : [extra.id, person.id];
      expect((await relation("PUT", caller, property.key, target2, headers)).status).toBe(200);
    });

    it("rejects a write or delete through a system-owned relation property with 403 owner_violation", async () => {
      const source = await chokePoint.createDatabase({ name: "Tasks" });
      const target = await chokePoint.createDatabase({ name: "People" });
      const { property } = await chokePoint.createRelationProperty({
        sourceDatabaseId: source.id,
        key: "systemLink",
        name: "System Link",
        targetDatabaseId: target.id,
      });
      // The public facade never accepts a `SystemRelationWriteContext`, so an owner:'system' property is set
      // directly in the DB.
      await pool.query("UPDATE properties SET owner = 'system', owner_process = $2 WHERE id = $1", [
        property.id,
        "some-internal-process",
      ]);
      const task = await chokePoint.createItem({ databaseId: source.id, properties: {} });
      const person = await chokePoint.createItem({ databaseId: target.id, properties: {} });
      const headers = await authHeader();
      for (const method of ["PUT", "DELETE"]) {
        await expectError(await relation(method, task.id, property.key, person.id, headers), 403, {
          code: "owner_violation",
        });
      }
    });

    it("lists a paired edge from each end under that end's own property, and an empty list without edges", async () => {
      const { source, target, property, inverseProperty, task, person } = await makePairedRelation();
      const headers = await authHeader();
      const list = async (id: string) => {
        const res = await api(`/api/items/${id}/relations`, { headers });
        expect(res.status).toBe(200);
        return res.json();
      };
      expect(await list(task.id)).toEqual({ relations: [] });
      await chokePoint.createRelation({
        relationPropertyId: property.id,
        callerItemId: task.id,
        targetItemId: person.id,
        metadata: { role: "owner" },
      });
      expect(await list(task.id)).toEqual({
        relations: [
          {
            relationPropertyId: property.id,
            propertyKey: "assignedTo",
            targetItemId: person.id,
            targetDatabaseId: target.id,
            metadata: { role: "owner" },
          },
        ],
      });
      expect(await list(person.id)).toEqual({
        relations: [
          {
            relationPropertyId: inverseProperty.id,
            propertyKey: "assignedTasks",
            targetItemId: task.id,
            targetDatabaseId: source.id,
            metadata: { role: "owner" },
          },
        ],
      });
    });

    it("narrows to one property with ?propertyKey= and answers 404 for a key that is not a relation of the item's database", async () => {
      const { source, target, property, task, person } = await makePairedRelation();
      const { property: watchers } = await chokePoint.createRelationProperty({
        sourceDatabaseId: source.id,
        key: "watchers",
        name: "Watchers",
        targetDatabaseId: target.id,
      });
      await chokePoint.createProperty({ databaseId: source.id, key: "notes", name: "Notes", type: "text" });
      const observer = await chokePoint.createItem({ databaseId: target.id, properties: {} });
      for (const [relationPropertyId, targetItemId] of [
        [property.id, person.id],
        [watchers.id, observer.id],
      ] as const) {
        await chokePoint.createRelation({ relationPropertyId, callerItemId: task.id, targetItemId });
      }
      const headers = await authHeader();
      const narrowed = await api(`/api/items/${task.id}/relations?propertyKey=watchers`, { headers });
      expect(narrowed.status).toBe(200);
      expect(relationTargets.parse(await narrowed.json()).relations).toEqual([
        { propertyKey: "watchers", targetItemId: observer.id },
      ]);
      for (const key of ["nope", "notes"]) {
        await expectError(await api(`/api/items/${task.id}/relations?propertyKey=${key}`, { headers }), 404, {
          code: "not_found",
        });
      }
    });

    /**
     * `UNIQUE(database_id, key)` makes more than one match unreachable, so the ambiguous branch is driven with only
     * `getPropertyByKey` overridden.
     */
    it.each(["GET", "PUT", "DELETE"] as const)(
      "%s answers 409 validation_failed ambiguous when the property lookup returns more than one match",
      async (method) => {
        const { source, property, task } = await makePairedRelation();
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
        const result = await route.handler({
          req: { url: `/api/items/${task.id}/relations?propertyKey=${property.key}` } as IncomingMessage,
          identity: { user: { id: randomUUID() } } as AuthenticatedIdentity,
          params: { id: task.id, propertyKey: property.key, targetItemId: randomUUID() },
          body: undefined,
        });
        expect(result).toEqual({
          status: 409,
          body: { error: { code: "validation_failed", details: { field: "propertyKey", reason: "ambiguous" } } },
        });
        expect(lookups).toEqual([{ databaseId: source.id, key: property.key, type: "relation" }]);
      },
    );
  });

  describe("GET /api/items/:id/related", () => {
    it("rejects an id that is not a uuid with 400", async () => {
      expect((await api("/api/items/not-a-uuid/related", { headers: await authHeader() })).status).toBe(400);
    });

    it("answers a bare array: empty for an item without connections, and the connected collections otherwise", async () => {
      const source = await chokePoint.createDatabase({ name: "Tasks" });
      const target = await chokePoint.createDatabase({ name: "People" });
      const { property } = await chokePoint.createRelationProperty({
        sourceDatabaseId: source.id,
        key: "assignedTo",
        name: "Assigned To",
        targetDatabaseId: target.id,
      });
      const task = await chokePoint.createItem({ databaseId: source.id, properties: {} });
      const person = await chokePoint.createItem({ databaseId: target.id, properties: {} });
      const headers = await authHeader();
      const related = async () => {
        const res = await api(`/api/items/${person.id}/related`, { headers });
        expect(res.status).toBe(200);
        return res.json();
      };
      expect(await related()).toEqual([]);
      await chokePoint.createRelation({
        relationPropertyId: property.id,
        callerItemId: task.id,
        targetItemId: person.id,
      });
      // The relation has no inverse property, so the person is found from the target side.
      expect(await related()).toEqual([
        {
          databaseKey: null,
          databaseId: source.id,
          count: 1,
          via: "direct",
          filter: { type: "relation_contains", property: "assignedTo", value: person.id },
        },
      ]);
    });
  });

  describe("GET /api/items/:id/delete-impact", () => {
    interface DeleteImpactBody {
      related: Array<{ databaseKey: string | null; count: number }>;
      subtreeItemCount: number;
      subtreePageCount: number;
      linksToOwn: Array<{ itemId: string; propertyKey: string }>;
      seriesInstanceCount: number;
      attachmentCount: number;
      hostEventCount: number;
    }

    const getImpact = (id: string, headers: HeaderMap) => api(`/api/items/${id}/delete-impact`, { headers });

    async function createSubpage(parentItemId: string, title: string, headers: HeaderMap) {
      const res = await api(
        `/api/items/${parentItemId}/page/subpages`,
        req("POST", { ...headers, "Content-Type": "application/json" }, { title }),
      );
      expect(res.status).toBe(201);
      const page = ((await res.json()) as { pages: Array<{ pageItemId: string }> }).pages[0];
      if (!page) throw new Error("Missing created page");
      return page.pageItemId;
    }

    it("rejects an id that is not a uuid with 400, and answers an unknown id and an item in the Trash with the same 404", async () => {
      const headers = await authHeader();
      const db = await chokePoint.createDatabase({ name: "Notes" });
      const trashed = await chokePoint.createItem({ databaseId: db.id, properties: {} });
      await chokePoint.softDeleteItem(db.id, trashed.id);
      expect((await getImpact("not-a-uuid", headers)).status).toBe(400);
      for (const id of [randomUUID(), trashed.id]) {
        await expectError(await getImpact(id, headers), 404, { code: "not_found" });
      }
    });

    it("answers all four parts for an item and changes no data", async () => {
      const headers = await authHeader();
      const tasks = await chokePoint.createDatabase({ name: "Tasks" });
      const notes = await chokePoint.createDatabase({ name: "Notes" });
      const { property } = await chokePoint.createRelationProperty({
        sourceDatabaseId: tasks.id,
        key: "note",
        name: "Note",
        targetDatabaseId: notes.id,
      });
      const note = await chokePoint.createItem({ databaseId: notes.id, properties: {} });
      const task = await chokePoint.createItem({ databaseId: tasks.id, properties: {} });
      await chokePoint.createRelation({
        relationPropertyId: property.id,
        callerItemId: task.id,
        targetItemId: note.id,
      });
      const inline = await chokePoint.createInlineDatabase({ name: "Rows", parentItemId: note.id });
      for (let index = 0; index < 3; index += 1) {
        await chokePoint.createItem({ databaseId: inline.id, properties: {} });
      }
      const page = await createSubpage(note.id, "Plan", headers);
      const first = await createSubpage(page, "A", headers);
      await createSubpage(page, "B", headers);
      await createSubpage(first, "Nested", headers);
      await withTransaction(pool, (client) =>
        insertValueLink(client, {
          itemId: task.id,
          propertyKey: "title",
          ruleKey: "test.titleFromNote",
          sources: [{ kind: "item", sourceItemId: note.id, sourcePropertyKey: "title" }],
        }),
      );
      const itemsBefore = await pool.query("SELECT count(*)::int AS n FROM items");
      const res = await getImpact(note.id, headers);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        related: [{ databaseKey: null, count: 1 }],
        subtreeItemCount: 3,
        subtreePageCount: 4,
        linksToOwn: [{ itemId: task.id, propertyKey: "title" }],
        // A database without an owner module counts no series numbers.
        seriesInstanceCount: 0,
        attachmentCount: 0,
        hostEventCount: 0,
      } satisfies DeleteImpactBody);
      expect((await pool.query("SELECT count(*)::int AS n FROM items")).rows).toEqual(itemsBefore.rows);
      expect((await chokePoint.getItem(notes.id, note.id))?.deletedAt).toBeNull();
    });

    it("counts the instances of a recurring task's series, its attachments and its host Events", async () => {
      await seed();
      const headers = await authHeader();
      const tasks = await moduleDatabase("tasks");
      const files = await moduleDatabase("files");
      const task = await chokePoint.createItem({
        databaseId: tasks.id,
        properties: { name: "Review", date: "2026-10-12" },
      });
      const seriesId = await startTaskSeries(pool, {
        databaseId: tasks.id,
        itemId: task.id,
        mode: "fixed",
        rule: { kind: "weekdays", days: ["mon"] },
      });
      for (const occurrenceDate of ["2026-10-19", "2026-10-26"]) {
        await createSeriesOccurrence(pool, { databaseId: tasks.id, seriesId, occurrenceDate, status: "notDone" });
      }
      const filesProperty = await propertyOf(tasks.id, "files");
      for (const name of ["a.pdf", "b.pdf"]) {
        const file = await chokePoint.createItem({ databaseId: files.id, properties: { name } });
        await chokePoint.createRelation({
          relationPropertyId: filesProperty.id,
          callerItemId: task.id,
          targetItemId: file.id,
        });
      }
      const res = await getImpact(task.id, headers);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ seriesInstanceCount: 3, attachmentCount: 2, hostEventCount: 0 });
    });

    it("reads all four parts in one repeatable-read snapshot", async () => {
      const db = await chokePoint.createDatabase({ name: "Notes" });
      const note = await chokePoint.createItem({ databaseId: db.id, properties: {} });
      const begins: string[] = [];
      const recordingPool = new Proxy(pool, {
        get(target, property) {
          if (property !== "connect") {
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async () => {
            const client = await target.connect();
            return new Proxy(client, {
              get(clientTarget, clientProperty) {
                const value: unknown = Reflect.get(clientTarget, clientProperty, clientTarget);
                if (clientProperty !== "query" || typeof value !== "function") {
                  return typeof value === "function" ? value.bind(clientTarget) : value;
                }
                return (...args: unknown[]) => {
                  const text = typeof args[0] === "string" ? args[0] : "";
                  if (text.startsWith("BEGIN")) begins.push(text);
                  return value.apply(clientTarget, args);
                };
              },
            });
          };
        },
      });
      const route = createItemRoutes(
        createGenericApplicationService(pool, testMetadataResolver),
        recordingPool,
        testMetadataResolver,
      ).find((candidate) => candidate.method === "GET" && candidate.path === "/api/items/:id/delete-impact");
      if (!route) throw new Error("expected the delete-impact route");
      const result = await inZero(() =>
        route.handler({
          req: { url: `/api/items/${note.id}/delete-impact` } as IncomingMessage,
          identity: { user: { id: randomUUID() } } as AuthenticatedIdentity,
          params: { id: note.id },
          body: undefined,
        }),
      );
      expect(result.status).toBe(200);
      expect(begins).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ"]);
    });

    it("answers a page with one subpage 1 and a page with two subpages, one of them nested into, 3", async () => {
      const headers = await authHeader();
      const db = await chokePoint.createDatabase({ name: "Hosts" });
      const host = await chokePoint.createItem({ databaseId: db.id, properties: {} });
      const page = await createSubpage(host.id, "Plan", headers);
      await createSubpage(page, "A", headers);
      const pageCount = async () =>
        ((await (await getImpact(page, headers)).json()) as DeleteImpactBody).subtreePageCount;
      expect(await pageCount()).toBe(1);
      const second = await createSubpage(page, "B", headers);
      await createSubpage(second, "Nested under B", headers);
      expect(await pageCount()).toBe(3);
    });
  });

  describe("page restore", () => {
    const HALF_HOUR_MS = 30 * 60 * 1000;

    /** History opens two hours before the database clock and `b1` is dated an hour before it. */
    async function pageWithBlock(): Promise<{ itemId: string; now: Date }> {
      const { rows } = await pool.query<{ now: Date }>(`SELECT transaction_timestamp() AS now`);
      const now = rows[0]!.now;
      const { item } = await makeMovie("Chapter");
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

    const restore = (itemId: string, body: unknown, headers: HeaderMap) =>
      api(`/api/items/${itemId}/page/restore`, req("POST", headers, body));

    it("restores the page to the instant and returns its block ids", async () => {
      const page = await pageWithBlock();
      const at = new Date(page.now.getTime() - HALF_HOUR_MS).toISOString();
      const res = await restore(page.itemId, { at }, await jsonAuth());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ itemId: page.itemId, at, blockIds: ["b1"] });
    });

    it("answers an unknown item and an item that has no page with 404", async () => {
      const { item } = await makeMovie("No page");
      const headers = await jsonAuth();
      const at = new Date(Date.now() - HALF_HOUR_MS).toISOString();
      for (const id of [randomUUID(), item.id]) {
        await expectError(await restore(id, { at }, headers), 404, { code: "not_found" });
      }
    });

    it("answers an instant before the retained history with 410, and a future, malformed or missing at with 400", async () => {
      const page = await pageWithBlock();
      const headers = await jsonAuth();
      const day = 24 * 60 * 60 * 1000;
      await expectError(
        await restore(page.itemId, { at: new Date(page.now.getTime() - day).toISOString() }, headers),
        410,
        {
          code: "history_not_retained",
        },
      );
      for (const body of [{ at: new Date(page.now.getTime() + day).toISOString() }, { at: "yesterday" }, {}]) {
        await expectError(await restore(page.itemId, body, headers), 400, { code: "validation_failed" });
      }
    });
  });

  describe("task and journal write boundaries over REST", () => {
    let headers: HeaderMap;
    let tasksDb: string;

    beforeEach(async () => {
      await seed();
      headers = await jsonAuth();
      tasksDb = (await moduleDatabase("tasks")).id;
    });

    async function createTask(properties: Properties) {
      return inZero(() => chokePoint.createItem({ databaseId: tasksDb, properties: { name: "Task", ...properties } }));
    }

    async function storedItem(id: string) {
      const item = await getItemInZero(tasksDb, id);
      if (!item) throw new Error(`Item ${id} missing`);
      return item;
    }

    const storedProperties = async (id: string) => (await storedItem(id)).properties;

    const recurrence = (method: "PUT" | "DELETE", id: string, body?: unknown) =>
      api(`/api/tasks/${id}/recurrence`, req(method, headers, body));

    it("sets a weekly recurrence on a Thursday task, refuses one without a date, and turns it off with DELETE", async () => {
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
      await expectValidation(await recurrence("PUT", undated.id, { preset: "weekly" }), "date");
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
        const { properties: before, version } = await storedItem(recurring.id);
        await expectValidation(await patchItem(recurring.id, headers, { date }, version), "date");
        expect(await storedProperties(recurring.id)).toEqual(before);
      },
    );

    it("clears the date of a task without a series over REST", async () => {
      const once = await createTask({ date: "2026-10-22", timeFrom: "09:00", timeTo: "10:00" });
      expect((await patchItem(once.id, headers, { date: null }, once.version)).status).toBe(200);
      expect(await storedProperties(once.id)).toMatchObject({ date: null, timeFrom: null, timeTo: null });
    });

    it("refuses a client PATCH of status missed with 400 on status, and accepts missed to done", async () => {
      const task = await createTask({ date: "2026-10-22" });
      const before = await storedProperties(task.id);
      await expectValidation(await patchItem(task.id, headers, { status: "missed" }, task.version), "status");
      expect(await storedProperties(task.id)).toEqual(before);
      await inZero(() =>
        chokePoint.updateItem({ databaseId: tasksDb, itemId: task.id, propertiesPatch: { status: "missed" } }),
      );
      expect((await patchItem(task.id, headers, { status: "done" }, (await storedItem(task.id)).version)).status).toBe(
        200,
      );
      expect(await storedProperties(task.id)).toMatchObject({ status: "done", completedOn: expect.any(String) });
    });

    it("answers 409 naming the live entry when restoring a Journal entry whose period is held, and 200 otherwise", async () => {
      const journalDb = (await moduleDatabase("journal")).id;
      const ensure = async (period: string) =>
        (await inZero(() => withTransaction(pool, (client) => ensureJournalPeriodDoc(client, "day", period)))).itemId;
      const restoreItem = (id: string) => api(`/api/items/${id}/restore`, { method: "POST", headers });
      const trashed = await ensure("2026-05-03");
      await inZero(() => chokePoint.softDeleteItem(journalDb, trashed));
      const live = await ensure("2026-05-03");
      expect(live).not.toBe(trashed);
      const held = await restoreItem(trashed);
      expect(held.status).toBe(409);
      expect(httpError.parse(await held.json()).error).toEqual({
        code: "version_conflict",
        details: { liveItemId: live },
      });
      const { rows } = await pool.query<{ deleted: boolean }>(
        "SELECT deleted_at IS NOT NULL AS deleted FROM items WHERE id = $1",
        [trashed],
      );
      expect(rows).toEqual([{ deleted: true }]);
      const alone = await ensure("2026-05-04");
      await inZero(() => chokePoint.softDeleteItem(journalDb, alone));
      const restored = await restoreItem(alone);
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
