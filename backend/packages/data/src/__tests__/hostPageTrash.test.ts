import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg, { type Pool, type PoolClient } from "pg";
import type * as Y from "yjs";
import { moveBlocks, readPageBlocks } from "@semprec/block-model";
import { runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabase } from "../chokePoint/databasesStore.js";
import {
  registerItemDeleteHook,
  registerItemRestoreHook,
  type ItemDeleteHookContext,
  type ItemRestoreHookContext,
} from "../chokePoint/hooks.js";
import { getItemsByIdsIncludingDeleted, lockItemById, lockItemTrashEpoch } from "../chokePoint/itemsStore.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { withTransaction } from "../db/pool.js";
import { loadDocWithClient, mutateDoc } from "../docs/docPersistence.js";
import { getDocByItemId } from "../docs/docsStore.js";
import { createSubpageWithClient } from "../docs/pageOperations.js";
import { PAGES_MODULE_ID } from "../docs/pagesDatabase.js";
import { collectSubpageTree, hostItemDeleteHook, hostItemRestoreHook, pageItemDeleteHook } from "../docs/pageTrash.js";
import { createActionQueueAffinity, type ActionQueueAffinity } from "../scheduler/actions.js";
import { seedSystem } from "../seed/seedSystem.js";
import { AREAS_MODULE_ID, EVENTS_MODULE_ID, PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  writePageTextBlocks,
} from "../testSupport/testDb.js";
import type { DatabaseRow, ItemRow } from "../types.js";

let admin: Pool;
let runtime: Pool;
let chokePoint: ChokePoint;
let tenant: string;

interface RecordedHookRun {
  itemId: string;
  rootItemId: string;
  writerKind: string;
  agentRunId: string | undefined;
  actingUserId: string | undefined;
  queueAffinity?: ActionQueueAffinity;
}

// Hooks cannot be unregistered; these recorders are emptied before each test. They are registered after the domain
// hooks, so the run for a row is recorded after the host hook has finished its nested trashes or restores for it.
const deleteRuns: RecordedHookRun[] = [];
const restoreRuns: RecordedHookRun[] = [];
registerItemDeleteHook(async ({ item, rootItemId, writerKind, agentRunId, actingUserId }) => {
  deleteRuns.push({ itemId: item.id, rootItemId, writerKind, agentRunId, actingUserId });
});
registerItemRestoreHook(async ({ item, rootItemId, writerKind, agentRunId, actingUserId, queueAffinity }) => {
  restoreRuns.push({ itemId: item.id, rootItemId, writerKind, agentRunId, actingUserId, queueAffinity });
});

beforeAll(async () => {
  admin = getTestPool();
  runtime = await createRuntimeRolePool(admin, "semprec_data");
  chokePoint = createChokePoint(runtime);
});
beforeEach(async () => {
  await resetDatabase(admin);
  tenant = getTenantZeroId();
  await runInTenant(tenant, () => seedSystem(runtime));
  deleteRuns.length = 0;
  restoreRuns.length = 0;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await admin.query("DROP TRIGGER IF EXISTS fail_host_page_trash_test ON doc_updates");
  await admin.query("DROP FUNCTION IF EXISTS fail_host_page_trash_test()");
  await admin.query("DROP TABLE IF EXISTS fail_host_page_trash_test_docs");
});
afterAll(async () => {
  const results = await Promise.allSettled([runtime?.end(), admin?.end()]);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, "Pool cleanup failed", { cause: errors[0] });
});

function inTenant<T>(fn: (client: PoolClient) => Promise<T>, tenantId = tenant): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(runtime, fn));
}

/** A new item of the system database of `moduleId`, written through the choke point. */
async function moduleItem(moduleId: string, properties: Record<string, unknown>, tenantId = tenant): Promise<string> {
  return runInTenant(tenantId, async () => {
    const database = (await chokePoint.listDatabases()).find(
      (candidate) => candidate.system && candidate.ownerModuleId === moduleId,
    );
    if (!database) throw new Error(`Missing the ${moduleId} database`);
    return (await chokePoint.createItem({ databaseId: database.id, properties })).id;
  });
}

function createProject(name = "Launch", tenantId = tenant): Promise<string> {
  return moduleItem(PROJECTS_MODULE_ID, { name }, tenantId);
}

interface Subpage {
  pageItemId: string;
  blockId: string;
}

async function createSubpage(
  parentItemId: string,
  title: string,
  afterBlockId?: string,
  tenantId = tenant,
): Promise<Subpage> {
  const created = await inTenant(
    (client) => createSubpageWithClient(client, { parent: { itemId: parentItemId }, title, afterBlockId }, "user"),
    tenantId,
  );
  const page = created.pages[0];
  if (!page) throw new Error("Missing created page");
  return page;
}

/** A Journal day, created with its first subpage the way the page operation creates a period entry. */
async function journalDayWithSubpage(title: string): Promise<{ host: string; page: Subpage }> {
  const created = await inTenant((client) =>
    createSubpageWithClient(client, { parent: { journal: { type: "day", period: "2026-10-16" } }, title }, "user"),
  );
  const page = created.pages[0];
  if (!page) throw new Error("Missing created page");
  const item = await runInTenant(tenant, () => chokePoint.findItem(page.pageItemId));
  const host: unknown = item?.properties.parentItemId;
  if (typeof host !== "string") throw new Error("The subpage names no Journal day");
  return { host, page };
}

interface TrashOptions {
  writer?: WriterIdentity;
  actingUserId?: string;
  via?: ChokePoint;
  tenantId?: string;
}

/** Trashes an item the way the application service does: resolve its database, then the choke point's cascade. */
async function trash(itemId: string, options: TrashOptions = {}): Promise<ItemRow | null> {
  const via = options.via ?? chokePoint;
  return runInTenant(options.tenantId ?? tenant, async () => {
    const item = await via.findItemIncludingDeleted(itemId);
    if (!item) throw new Error(`Item ${itemId} does not exist`);
    return via.softDeleteItem(item.databaseId, itemId, options.actingUserId, options.writer);
  });
}

async function restore(itemId: string, options: TrashOptions = {}): Promise<ItemRow | null> {
  const via = options.via ?? chokePoint;
  return runInTenant(options.tenantId ?? tenant, async () => {
    const item = await via.findItemIncludingDeleted(itemId);
    if (!item) throw new Error(`Item ${itemId} does not exist`);
    return via.restoreItem(item.databaseId, itemId, options.actingUserId, options.writer);
  });
}

/** Whether each item is live, in the order given, read inside `tenantId`; a missing row fails the test. */
async function liveStatesIn(tenantId: string, ...itemIds: string[]): Promise<boolean[]> {
  return runInTenant(tenantId, async () => {
    const states: boolean[] = [];
    for (const itemId of itemIds) {
      const item = await chokePoint.findItemIncludingDeleted(itemId);
      if (!item) throw new Error(`Item ${itemId} does not exist`);
      states.push(item.deletedAt === null);
    }
    return states;
  });
}

function liveStates(...itemIds: string[]): Promise<boolean[]> {
  return liveStatesIn(tenant, ...itemIds);
}

/** The ids of `itemIds` that the live item read finds, the read behind `GET /api/items/:id`. */
async function foundLive(...itemIds: string[]): Promise<string[]> {
  return runInTenant(tenant, async () => {
    const found: string[] = [];
    for (const itemId of itemIds) {
      if ((await chokePoint.findItem(itemId)) !== null) found.push(itemId);
    }
    return found;
  });
}

/** `deleted_at` of an item as Postgres renders it, with its full precision; `null` for a live item. */
async function deletedAtExact(itemId: string, tenantId = tenant): Promise<string | null> {
  const { rows } = await inTenant(
    (client) =>
      client.query<{ deleted_at: string | null }>(`SELECT deleted_at::text AS deleted_at FROM items WHERE id = $1`, [
        itemId,
      ]),
    tenantId,
  );
  const row = rows[0];
  if (!row) throw new Error(`Item ${itemId} does not exist`);
  return row.deleted_at;
}

interface BlockView {
  id: string | null;
  type: string;
  pageId: string | null;
  indent: number;
  text: string;
}

interface DocumentView {
  blocks: BlockView[];
  trashedPages: Record<string, unknown>;
}

async function docIdOf(itemId: string, tenantId = tenant): Promise<string> {
  const doc = await inTenant((client) => getDocByItemId(client, itemId), tenantId);
  if (!doc) throw new Error(`Item ${itemId} has no document`);
  return doc.id;
}

/** The stored blocks of an item's page in document order, and its `trashedPages` map. */
async function readDocument(itemId: string, tenantId = tenant): Promise<DocumentView> {
  const docId = await docIdOf(itemId, tenantId);
  return inTenant(async (client) => {
    const doc = await loadDocWithClient(client, docId);
    try {
      const trashedPages: Record<string, unknown> = doc.getMap<unknown>("trashedPages").toJSON();
      return {
        blocks: readPageBlocks(doc)
          .filter((block) => !block.synthetic)
          .map(({ id, type, pageId, indent, text }) => ({
            id,
            type,
            pageId,
            indent,
            text: text.map((run) => run.insert).join(""),
          })),
        trashedPages,
      };
    } finally {
      doc.destroy();
    }
  }, tenantId);
}

function pageBlocks(document: DocumentView): BlockView[] {
  return document.blocks.filter((block) => block.type === "page");
}

/** An edit of an item's page as an editor makes it over the sync socket, outside the page operations. */
async function editDocument(itemId: string, edit: (doc: Y.Doc) => void): Promise<void> {
  const docId = await docIdOf(itemId);
  await runInTenant(tenant, () => mutateDoc(runtime, docId, "user", edit));
}

/** The authors of the stored updates of an item's page, oldest first. */
async function updateAuthors(itemId: string, tenantId = tenant): Promise<string[]> {
  const docId = await docIdOf(itemId, tenantId);
  const { rows } = await inTenant(
    (client) =>
      client.query<{ created_by: string }>(`SELECT created_by FROM doc_updates WHERE doc_id = $1 ORDER BY id`, [docId]),
    tenantId,
  );
  return rows.map((row) => row.created_by);
}

/** The ids of the text blocks `texts` appended to the notes of `itemId`, in order. */
async function appendTextBlocks(itemId: string, texts: string[]): Promise<string[]> {
  await runInTenant(tenant, () => writePageTextBlocks(runtime, itemId, texts));
  const ids = (await readDocument(itemId)).blocks
    .filter((block) => block.type === "text" && texts.includes(block.text))
    .flatMap((block) => (block.id === null ? [] : [block.id]));
  if (ids.length !== texts.length) throw new Error("Missing seed blocks");
  return ids;
}

interface ProjectWithSubpages {
  project: string;
  first: string;
  second: string;
  checklist: Subpage;
  risks: Subpage;
  nested: Subpage;
}

/**
 * A project whose notes read `first`, the page block of `checklist`, `second`, the page block of `risks`; `nested` is
 * a page below `checklist`.
 */
async function projectWithSubpages(): Promise<ProjectWithSubpages> {
  const project = await createProject();
  const [first, second] = await appendTextBlocks(project, ["first", "second"]);
  if (!first || !second) throw new Error("Missing seed blocks");
  const checklist = await createSubpage(project, "Release checklist", first);
  const risks = await createSubpage(project, "Risks", second);
  const nested = await createSubpage(checklist.pageItemId, "Notes for version 0.4");
  return { project, first, second, checklist, risks, nested };
}

/**
 * Two subpages of `parentItemId`. `lower` is the one with the lower item id, which a trash of the parent reaches first.
 * Canonical UUID strings compare like the `uuid` values Postgres orders by.
 */
async function twoSubpagesOf(parentItemId: string): Promise<{ lower: Subpage; higher: Subpage }> {
  const a = await createSubpage(parentItemId, "Subpage A");
  const b = await createSubpage(parentItemId, "Subpage B");
  const [lower, higher] = a.pageItemId < b.pageItemId ? [a, b] : [b, a];
  return { lower, higher };
}

/** Every Pages item of `tenantId` as stored and the number of stored document updates: what a trash may change. */
async function pagesAndUpdates(tenantId = tenant): Promise<unknown> {
  return inTenant(async (client) => {
    const pages = await client.query<{ row: unknown }>(
      `SELECT to_jsonb(i) AS row FROM items i JOIN databases d ON d.id = i.database_id
        WHERE d.owner_module_id = $1 ORDER BY i.id`,
      [PAGES_MODULE_ID],
    );
    const updates = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM doc_updates`);
    return { pages: pages.rows.map((row) => row.row), updates: updates.rows[0]?.n };
  }, tenantId);
}

/** Makes every later stored update of `itemId`'s page fail inside the database. */
async function failDocumentWritesOf(itemId: string): Promise<void> {
  const docId = await docIdOf(itemId);
  // Fault injection inside the document write itself: no production input makes the append fail. The document id
  // reaches the trigger through a scratch table, not interpolated into its body.
  await admin.query("CREATE TABLE fail_host_page_trash_test_docs (doc_id uuid PRIMARY KEY)");
  await admin.query("INSERT INTO fail_host_page_trash_test_docs (doc_id) VALUES ($1)", [docId]);
  await admin.query("GRANT SELECT ON fail_host_page_trash_test_docs TO PUBLIC");
  await admin.query(`CREATE FUNCTION fail_host_page_trash_test() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM fail_host_page_trash_test_docs WHERE doc_id = NEW.doc_id) THEN
        RAISE EXCEPTION 'host document write failure';
      END IF;
      RETURN NEW;
    END $$`);
  await admin.query(`CREATE TRIGGER fail_host_page_trash_test BEFORE INSERT ON doc_updates
    FOR EACH ROW EXECUTE FUNCTION fail_host_page_trash_test()`);
}

/** Records the text of every statement a client of this process sends, until `stop` is called. */
function recordStatements(): { texts: string[]; stop: () => void } {
  const texts: string[] = [];
  // Called back with the receiving client below, so the unbound reference is safe.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalQuery: (this: pg.Client, ...args: unknown[]) => unknown = pg.Client.prototype.query;
  const spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (this: pg.Client, ...args: unknown[]) {
    const [statement] = args;
    // A statement is sent as its text or as a query config that carries the text.
    const text: unknown =
      typeof statement === "object" && statement !== null && "text" in statement ? statement.text : statement;
    if (typeof text === "string") texts.push(text);
    return originalQuery.apply(this, args);
  });
  return { texts, stop: () => spy.mockRestore() };
}

const READS_PAGES_DATABASE = /FROM databases WHERE owner_module_id = \$1 AND system/;
const LOCKS_LIVE_SUBPAGES = /properties->>'parentItemId' = \$2 AND deleted_at IS NULL[\s\S]*FOR UPDATE/;
const LOCKS_EPOCH_SUBPAGES = /properties->>'parentItemId' = \$2 AND deleted_at = \$3::timestamptz[\s\S]*FOR UPDATE/;
const READS_TRASH_EPOCH = /to_char\(deleted_at[\s\S]*FOR SHARE/;
const WRITES = /^\s*(INSERT|UPDATE|DELETE)\b/i;

/** The stored row and database of `itemId`, read on `client`. */
async function rowAndDatabase(client: PoolClient, itemId: string): Promise<{ item: ItemRow; database: DatabaseRow }> {
  const [visible] = await getItemsByIdsIncludingDeleted(client, [itemId]);
  const item = visible ? await lockItemById(client, visible.databaseId, itemId) : null;
  if (!item) throw new Error(`Item ${itemId} does not exist`);
  const database = await getDatabase(client, item.databaseId);
  if (!database) throw new Error(`Database ${item.databaseId} does not exist`);
  return { item, database };
}

/**
 * Calls `hostItemDeleteHook` on its own for the stored row of `itemId`, with the context the cascade builds for a root
 * it trashed as the system writer, and returns the statements the hook sent. For a live row `deletedAt` is a stand-in.
 */
async function deleteHookStatements(itemId: string, tenantId = tenant): Promise<string[]> {
  return inTenant(async (client) => {
    const { item, database } = await rowAndDatabase(client, itemId);
    const context: ItemDeleteHookContext = {
      client,
      database,
      item,
      rootItemId: item.id,
      deletedAt: item.deletedAt ?? item.updatedAt,
      writerKind: "system",
    };
    const recorded = recordStatements();
    try {
      await hostItemDeleteHook(context);
    } finally {
      recorded.stop();
    }
    return recorded.texts;
  }, tenantId);
}

/**
 * Calls `pageItemDeleteHook` on its own for the stored Pages row of `itemId`, with the context the cascade builds for a
 * root it trashed as the system writer, and returns the statements the hook sent before it returned or threw. For a
 * live row `deletedAt` is a stand-in.
 */
async function pageDeleteHookStatements(itemId: string): Promise<{ statements: string[]; error: unknown }> {
  return inTenant(async (client) => {
    const { item, database } = await rowAndDatabase(client, itemId);
    const context: ItemDeleteHookContext = {
      client,
      database,
      item,
      rootItemId: item.id,
      deletedAt: item.deletedAt ?? item.updatedAt,
      writerKind: "system",
    };
    const recorded = recordStatements();
    let error: unknown = null;
    try {
      await pageItemDeleteHook(context);
    } catch (thrown) {
      error = thrown;
    } finally {
      recorded.stop();
    }
    return { statements: recorded.texts, error };
  });
}

/**
 * Calls `hostItemRestoreHook` on its own for the stored row of the trashed item `itemId`, with the context the cascade
 * builds for a root of the deletion epoch `epoch` that it restores as the system writer, and returns the statements
 * the hook sent.
 */
async function restoreHookStatements(itemId: string, epoch: string, tenantId = tenant): Promise<string[]> {
  return inTenant(async (client) => {
    const { item, database } = await rowAndDatabase(client, itemId);
    if (item.deletedAt === null) throw new Error(`Item ${itemId} is not in the Trash`);
    const context: ItemRestoreHookContext = {
      client,
      database,
      item,
      rootItemId: item.id,
      deletedAt: item.deletedAt,
      deletedAtExact: epoch,
      queueAffinity: createActionQueueAffinity(),
      writerKind: "system",
    };
    const recorded = recordStatements();
    try {
      await hostItemRestoreHook(context);
    } finally {
      recorded.stop();
    }
    return recorded.texts;
  }, tenantId);
}

/** The exact deletion epoch of a trashed item, in the text form a restore hook receives. */
async function trashEpochOf(itemId: string, tenantId = tenant): Promise<string> {
  const epoch = await inTenant(async (client) => {
    const { item } = await rowAndDatabase(client, itemId);
    return lockItemTrashEpoch(client, item.databaseId, item.id);
  }, tenantId);
  if (epoch === null) throw new Error(`Item ${itemId} is not in the Trash`);
  return epoch;
}

/** How long a test waits for a step of a concurrent scenario before it fails instead of hanging. */
const WAIT_MS = 15_000;

function withinWait<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not happen within ${WAIT_MS} ms`)), WAIT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Rejects as soon as `write` settles: a write that should still be in flight has finished, or it failed. */
function settledEarly(write: Promise<unknown>, label: string): Promise<never> {
  return write.then((): never => {
    throw new Error(`${label} finished before it was expected to`);
  });
}

describe("host trash and restore hooks (issue #1763)", () => {
  it("trashes a project's two subpages and their nested page with it, hides them and takes their blocks out of the project's notes", async () => {
    const { project, first, second, checklist, risks, nested } = await projectWithSubpages();
    const pages = [checklist.pageItemId, risks.pageItemId, nested.pageItemId];
    expect(await foundLive(...pages)).toEqual(pages);

    const trashed = await trash(project);

    expect(trashed).toMatchObject({ id: project });
    expect(await liveStates(project, ...pages)).toEqual([false, false, false, false]);
    expect(await foundLive(...pages)).toEqual([]);
    expect(await inTenant((client) => collectSubpageTree(client, project))).toEqual([]);
    // The subpages carry the project's own timestamp at the column's full precision.
    const epoch = await deletedAtExact(project);
    expect(epoch).not.toBeNull();
    for (const page of pages) expect(await deletedAtExact(page)).toBe(epoch);

    const notes = await readDocument(project);
    expect(notes.blocks.map((block) => block.id)).toEqual([first, second]);
    expect(notes.trashedPages).toEqual({
      [checklist.pageItemId]: { blockId: checklist.blockId, afterBlockId: first, indent: 0 },
      [risks.pageItemId]: { blockId: risks.blockId, afterBlockId: second, indent: 0 },
    });
    const checklistPage = await readDocument(checklist.pageItemId);
    expect(pageBlocks(checklistPage)).toEqual([]);
    expect(checklistPage.trashedPages).toEqual({
      [nested.pageItemId]: { blockId: nested.blockId, afterBlockId: null, indent: 0 },
    });
  });

  it("restores the project with its subpages and their nested page, and puts every block back where it stood", async () => {
    const { project, checklist, risks, nested } = await projectWithSubpages();
    const pages = [checklist.pageItemId, risks.pageItemId, nested.pageItemId];
    const before = { notes: await readDocument(project), checklistPage: await readDocument(checklist.pageItemId) };
    await trash(project);

    const restored = await restore(project);

    expect(restored).toMatchObject({ id: project, deletedAt: null });
    expect(await liveStates(project, ...pages)).toEqual([true, true, true, true]);
    expect(await foundLive(...pages)).toEqual(pages);
    expect(await readDocument(project)).toEqual(before.notes);
    const checklistPage = await readDocument(checklist.pageItemId);
    expect(pageBlocks(checklistPage)).toEqual(pageBlocks(before.checklistPage));
    expect(checklistPage.trashedPages).toEqual({});
  });

  it.each([
    { name: "in the order of their ids", lowerIdFirst: true },
    { name: "against the order of their ids", lowerIdFirst: false },
  ])(
    "puts two adjacent subpage blocks that stand $name back where they stood when their project is restored",
    async ({ lowerIdFirst }) => {
      const project = await createProject();
      const { lower, higher } = await twoSubpagesOf(project);
      const [intro, outro] = await appendTextBlocks(project, ["intro", "outro"]);
      if (!intro || !outro) throw new Error("Missing seed blocks");
      const [one, other] = lowerIdFirst ? [lower, higher] : [higher, lower];
      // The editor drags both page blocks between the two text blocks.
      await editDocument(project, (doc) => {
        moveBlocks(doc, [one.blockId], intro);
        moveBlocks(doc, [other.blockId], one.blockId);
      });
      const before = await readDocument(project);
      expect(before.blocks.map((block) => block.id)).toEqual([intro, one.blockId, other.blockId, outro]);

      await trash(project);

      const trashedNotes = await readDocument(project);
      expect(trashedNotes.blocks.map((block) => block.id)).toEqual([intro, outro]);
      expect(Object.keys(trashedNotes.trashedPages).sort()).toEqual([lower.pageItemId, higher.pageItemId]);

      await restore(project);

      expect(await liveStates(project, lower.pageItemId, higher.pageItemId)).toEqual([true, true, true]);
      expect(await readDocument(project)).toEqual(before);
    },
  );

  it("leaves a subpage in the Trash that was trashed before its host", async () => {
    const { project, checklist, risks, nested } = await projectWithSubpages();
    await trash(risks.pageItemId);
    const risksEpoch = await deletedAtExact(risks.pageItemId);
    await trash(project);
    expect(await deletedAtExact(project)).not.toBe(risksEpoch);
    expect(await deletedAtExact(risks.pageItemId)).toBe(risksEpoch);

    await restore(project);

    expect(await liveStates(project, checklist.pageItemId, nested.pageItemId, risks.pageItemId)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(await deletedAtExact(risks.pageItemId)).toBe(risksEpoch);
    const notes = await readDocument(project);
    expect(pageBlocks(notes).map((block) => block.pageId)).toEqual([checklist.pageItemId]);
    expect(Object.keys(notes.trashedPages)).toEqual([risks.pageItemId]);
  });

  it.each<{ name: string; create: () => Promise<{ host: string; page: Subpage }> }>([
    {
      name: "an area",
      create: async () => {
        const host = await moduleItem(AREAS_MODULE_ID, { name: "Health" });
        return { host, page: await createSubpage(host, "Area notes") };
      },
    },
    {
      name: "an event",
      create: async () => {
        const host = await moduleItem(EVENTS_MODULE_ID, { name: "Client meeting", date: "2026-11-16" });
        return { host, page: await createSubpage(host, "Meeting notes") };
      },
    },
    { name: "a Journal day", create: () => journalDayWithSubpage("Day notes") },
  ])("trashes the subpage of $name and its nested page with it, and restores both with it", async ({ create }) => {
    const { host, page } = await create();
    const nested = await createSubpage(page.pageItemId, "Nested");
    // A text block after the page block, so the host's notes are not left empty when the page block goes.
    await appendTextBlocks(host, ["closing note"]);
    const before = await readDocument(host);
    expect(pageBlocks(before).map((block) => block.pageId)).toEqual([page.pageItemId]);

    expect(await trash(host)).toMatchObject({ id: host });

    expect(await liveStates(host, page.pageItemId, nested.pageItemId)).toEqual([false, false, false]);
    expect(await foundLive(page.pageItemId, nested.pageItemId)).toEqual([]);
    const epoch = await deletedAtExact(host);
    expect(epoch).not.toBeNull();
    expect(await deletedAtExact(page.pageItemId)).toBe(epoch);
    expect(await deletedAtExact(nested.pageItemId)).toBe(epoch);
    const trashedNotes = await readDocument(host);
    expect(pageBlocks(trashedNotes)).toEqual([]);
    expect(Object.keys(trashedNotes.trashedPages)).toEqual([page.pageItemId]);

    expect(await restore(host)).toMatchObject({ id: host, deletedAt: null });

    expect(await liveStates(host, page.pageItemId, nested.pageItemId)).toEqual([true, true, true]);
    expect(await readDocument(host)).toEqual(before);
    expect(pageBlocks(await readDocument(page.pageItemId)).map((block) => block.pageId)).toEqual([nested.pageItemId]);
  });

  it("trashes a project without subpages as before: its hooks run for it alone, and no page or document is written", async () => {
    // Another project holds subpages, so the tenant has a Pages database and the hook looks for subpages.
    const other = await projectWithSubpages();
    const project = await createProject("Plain");
    await appendTextBlocks(project, ["note"]);
    const before = { pagesAndUpdates: await pagesAndUpdates(), notes: await readDocument(project) };
    const recorded = recordStatements();
    let trashed: ItemRow | null;
    try {
      trashed = await trash(project);
    } finally {
      recorded.stop();
    }

    expect(trashed).toMatchObject({ id: project });
    expect(trashed?.deletedAt).not.toBeNull();
    expect(deleteRuns).toEqual([
      { itemId: project, rootItemId: project, writerKind: "system", agentRunId: undefined, actingUserId: undefined },
    ]);
    expect(await liveStates(project, other.project, other.checklist.pageItemId)).toEqual([false, true, true]);
    expect({ pagesAndUpdates: await pagesAndUpdates(), notes: await readDocument(project) }).toEqual(before);
    // The whole trash looked for subpages once, soft-deleted one row and never read a deletion epoch to pass on.
    expect(recorded.texts.filter((text) => LOCKS_LIVE_SUBPAGES.test(text))).toHaveLength(1);
    expect(recorded.texts.filter((text) => /^\s*UPDATE items SET deleted_at/.test(text))).toHaveLength(1);
    expect(recorded.texts.filter((text) => READS_TRASH_EPOCH.test(text))).toEqual([]);
    expect(recorded.texts.filter((text) => /INSERT INTO doc_updates/.test(text))).toEqual([]);

    expect(await restore(project)).toMatchObject({ id: project, deletedAt: null });
    expect(restoreRuns.map((run) => run.itemId)).toEqual([project]);
    expect({ pagesAndUpdates: await pagesAndUpdates(), notes: await readDocument(project) }).toEqual(before);
  });

  it("trashes a subpage hosted by an item of an inline database when the cascade reaches that item, and restores it with the cascade", async () => {
    const project = await createProject();
    const row = await runInTenant(tenant, async () => {
      const inline = await chokePoint.createInlineDatabase({ name: "Milestones", parentItemId: project });
      return (await chokePoint.createItem({ databaseId: inline.id, properties: {} })).id;
    });
    const page = await createSubpage(row, "Milestone notes");
    await appendTextBlocks(row, ["closing note"]);
    const before = await readDocument(row);

    await trash(project);

    expect(await liveStates(project, row, page.pageItemId)).toEqual([false, false, false]);
    const epoch = await deletedAtExact(project);
    expect(await deletedAtExact(row)).toBe(epoch);
    expect(await deletedAtExact(page.pageItemId)).toBe(epoch);
    // The subpage is the root of a trash of its own, which the hook started in its run for the inline row.
    expect(deleteRuns.map((run) => [run.itemId, run.rootItemId])).toEqual([
      [project, project],
      [page.pageItemId, page.pageItemId],
      [row, project],
    ]);
    expect(pageBlocks(await readDocument(row))).toEqual([]);

    await restore(project);

    expect(await liveStates(project, row, page.pageItemId)).toEqual([true, true, true]);
    expect(await readDocument(row)).toEqual(before);
  });

  it("rolls the host's trash back when a hook fails: the host and its subpages stay live and every block stays", async () => {
    const { project, checklist, risks, nested } = await projectWithSubpages();
    const pages = [checklist.pageItemId, risks.pageItemId, nested.pageItemId];
    const before = {
      notes: await readDocument(project),
      checklistPage: await readDocument(checklist.pageItemId),
      pagesAndUpdates: await pagesAndUpdates(),
    };
    // The project's notes are written when the first subpage's block is taken out, after that subpage was trashed in
    // the transaction.
    await failDocumentWritesOf(project);

    await expect(trash(project)).rejects.toThrow("host document write failure");

    expect(await liveStates(project, ...pages)).toEqual([true, true, true, true]);
    expect(await foundLive(project, ...pages)).toEqual([project, ...pages]);
    expect({
      notes: await readDocument(project),
      checklistPage: await readDocument(checklist.pageItemId),
      pagesAndUpdates: await pagesAndUpdates(),
    }).toEqual(before);
  });

  it("rolls the host's restore back when a hook fails: the host and its subpages stay in the Trash", async () => {
    const { project, checklist, risks, nested } = await projectWithSubpages();
    const pages = [checklist.pageItemId, risks.pageItemId, nested.pageItemId];
    await trash(project);
    const epochs = async () => Promise.all([project, ...pages].map((itemId) => deletedAtExact(itemId)));
    const before = {
      epochs: await epochs(),
      notes: await readDocument(project),
      checklistPage: await readDocument(checklist.pageItemId),
    };
    expect(before.epochs.every((epoch) => epoch !== null)).toBe(true);
    await failDocumentWritesOf(project);

    await expect(restore(project)).rejects.toThrow("host document write failure");

    expect({
      epochs: await epochs(),
      notes: await readDocument(project),
      checklistPage: await readDocument(checklist.pageItemId),
    }).toEqual(before);
  });

  it.each([
    { name: "a user", writer: { writerKind: "user" } satisfies WriterIdentity, author: "user" },
    {
      name: "an agent run",
      writer: { writerKind: "agent", agentRunId: randomUUID() } satisfies WriterIdentity,
      author: "ai_agent",
    },
  ])(
    "trashes and restores the subpages as $name with the host's acting user, and restores them with the caller's queue routing",
    async ({ writer, author }) => {
      const queueAffinity: ActionQueueAffinity = new Map();
      const via = createChokePoint(runtime, undefined, undefined, queueAffinity);
      const actingUserId = randomUUID();
      const project = await createProject();
      const page = await createSubpage(project, "Release checklist");
      const expectedRun = {
        itemId: page.pageItemId,
        rootItemId: page.pageItemId,
        writerKind: writer.writerKind,
        agentRunId: "agentRunId" in writer ? writer.agentRunId : undefined,
        actingUserId,
      };

      await trash(project, { via, writer, actingUserId });

      expect(deleteRuns.find((run) => run.itemId === page.pageItemId)).toEqual(expectedRun);
      // The page was created by one `user` update of the notes; the trash appended one authored by its writer.
      expect(await updateAuthors(project)).toEqual(["user", author]);

      await restore(project, { via, writer, actingUserId });

      const pageRestore = restoreRuns.find((run) => run.itemId === page.pageItemId);
      expect(pageRestore).toMatchObject(expectedRun);
      expect(pageRestore?.queueAffinity).toBe(queueAffinity);
      expect(await updateAuthors(project)).toEqual(["user", author, author]);
    },
  );

  it("gives the subpages and the pages below them the host's deletion epoch when the host's trash joins an earlier one, and restores them with the host", async () => {
    const anchor = await createProject("Trashed earlier");
    await trash(anchor);
    const anchorEpoch = await trashEpochOf(anchor);
    const project = await createProject();
    const page = await createSubpage(project, "Release checklist");
    const nested = await createSubpage(page.pageItemId, "Notes for version 0.4");
    const deepest = await createSubpage(nested.pageItemId, "Open questions");
    await appendTextBlocks(project, ["closing note"]);
    const before = await readDocument(project);
    const pageBefore = await readDocument(page.pageItemId);
    const nestedBefore = await readDocument(nested.pageItemId);

    // The project joins the anchor's epoch, the way the mailbox removal job makes a folder join its mailbox's.
    await inTenant(async (client) => {
      const { item } = await rowAndDatabase(client, project);
      await itemDeleteWithClient(client, item.databaseId, project, {
        queueAffinity: createActionQueueAffinity(),
        deletedAtExact: anchorEpoch,
      });
    });

    expect(await trashEpochOf(project)).toBe(anchorEpoch);
    expect(await trashEpochOf(page.pageItemId)).toBe(anchorEpoch);
    // The pages below the subpage join the epoch of the subpage, not the later time of this transaction.
    expect(await trashEpochOf(nested.pageItemId)).toBe(anchorEpoch);
    expect(await trashEpochOf(deepest.pageItemId)).toBe(anchorEpoch);

    await restore(project);

    expect(await liveStates(project, page.pageItemId, nested.pageItemId, deepest.pageItemId, anchor)).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(await readDocument(project)).toEqual(before);
    // The block of each nested page is back in the document of its parent and its record is gone. A page whose only
    // block was removed keeps the empty text block the removal left, so the blocks of other types are not compared.
    for (const [parent, before] of [
      [page.pageItemId, pageBefore],
      [nested.pageItemId, nestedBefore],
    ] as const) {
      const after = await readDocument(parent);
      expect(pageBlocks(after)).toEqual(pageBlocks(before));
      expect(after.trashedPages).toEqual({});
    }
  });

  it("trashes a host while the later of its two subpages is being trashed on its own, and both trashes finish", async () => {
    const project = await createProject();
    const { lower, higher } = await twoSubpagesOf(project);
    const pagesDatabaseId = (await runInTenant(tenant, () => chokePoint.findItem(higher.pageItemId)))?.databaseId;
    if (!pagesDatabaseId) throw new Error("Missing Pages database");

    let rowLocked: (pid: number) => void = () => undefined;
    const lockedBy = new Promise<number>((resolve) => {
      rowLocked = resolve;
    });
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The trash of the later subpage on its own, held right after the first lock it takes, the one on its own row.
    const subpageTrash = inTenant(async (client) => {
      await lockItemById(client, pagesDatabaseId, higher.pageItemId);
      const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const pid = rows[0]?.pid;
      if (pid === undefined) throw new Error("No backend pid");
      rowLocked(pid);
      await released;
      return itemDeleteWithClient(client, pagesDatabaseId, higher.pageItemId, {
        queueAffinity: createActionQueueAffinity(),
        writer: { writerKind: "user" },
      });
    });
    let hostTrash: Promise<ItemRow | null> | undefined;
    try {
      const holder = await withinWait(
        Promise.race([lockedBy, settledEarly(subpageTrash, "The trash of the subpage")]),
        "The row lock of the subpage",
      );
      const started = trash(project);
      hostTrash = started;
      // The trash of the host has reached the subpage's row and waits for the transaction that holds it.
      await Promise.race([
        vi.waitFor(
          async () => {
            const { rows } = await admin.query<{ waiting: boolean }>(
              "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS waiting",
              [holder],
            );
            expect(rows[0]?.waiting).toBe(true);
          },
          { timeout: WAIT_MS, interval: 20 },
        ),
        settledEarly(started, "The trash of the host"),
      ]);
      release();
      // A wait cycle between the two ends with PostgreSQL aborting one of them (40P01, deadlock detected).
      await withinWait(Promise.all([subpageTrash, started]), "The end of both trashes");
    } finally {
      release();
      await Promise.allSettled([subpageTrash, hostTrash]);
    }

    expect(await liveStates(project, lower.pageItemId, higher.pageItemId)).toEqual([false, false, false]);
    // The subpage trashed on its own committed first and keeps its own epoch; the host's trash left it out.
    const epoch = await deletedAtExact(project);
    expect(await deletedAtExact(lower.pageItemId)).toBe(epoch);
    expect(await deletedAtExact(higher.pageItemId)).not.toBe(epoch);
    const notes = await readDocument(project);
    expect(pageBlocks(notes)).toEqual([]);
    expect(Object.keys(notes.trashedPages).sort()).toEqual([lower.pageItemId, higher.pageItemId]);
  });

  it("leaves another tenant's pages alone, also one whose stored parentItemId is this tenant's host", async () => {
    const otherTenant = await createTestTenant(admin);
    await runInTenant(otherTenant, () => seedSystem(runtime));
    const project = await createProject();
    const page = await createSubpage(project, "Mine");
    const otherProject = await createProject("Theirs", otherTenant);
    const otherPage = await createSubpage(otherProject, "Their notes", undefined, otherTenant);
    const stray = await createSubpage(otherProject, "Stray", undefined, otherTenant);
    // No operation stores a parent of another tenant; this superuser write stands in for a page that names a foreign id.
    const renamedParent = await admin.query(
      `UPDATE items SET properties = jsonb_set(properties, '{parentItemId}', to_jsonb($2::text)) WHERE id = $1`,
      [stray.pageItemId, project],
    );
    expect(renamedParent.rowCount).toBe(1);
    const theirs = async () => ({
      live: await liveStatesIn(otherTenant, otherProject, otherPage.pageItemId, stray.pageItemId),
      pagesAndUpdates: await pagesAndUpdates(otherTenant),
      notes: await readDocument(otherProject, otherTenant),
    });
    const before = await theirs();
    expect(before.live).toEqual([true, true, true]);

    await trash(project);

    expect(await liveStates(project, page.pageItemId)).toEqual([false, false]);
    expect(await theirs()).toEqual(before);

    // The stray page joins the epoch by a superuser write: the restore must still not reach into the other tenant.
    const joinedEpoch = await admin.query(`UPDATE items SET deleted_at = $2::timestamptz WHERE id = $1`, [
      stray.pageItemId,
      await trashEpochOf(project),
    ]);
    expect(joinedEpoch.rowCount).toBe(1);
    const strayTrashed = await theirs();
    expect(strayTrashed.live).toEqual([true, true, false]);

    await restore(project);

    expect(await liveStates(project, page.pageItemId)).toEqual([true, true]);
    expect(await theirs()).toEqual(strayTrashed);
  });
});

describe("host hooks on rows they do not act on (issue #1763)", () => {
  it("sends no statement for an item of the Pages database", async () => {
    const project = await createProject();
    const page = await createSubpage(project, "Release checklist");
    const nested = await createSubpage(page.pageItemId, "Notes");
    await trash(page.pageItemId);
    const epoch = await trashEpochOf(page.pageItemId);

    expect(await deleteHookStatements(page.pageItemId)).toEqual([]);
    expect(await restoreHookStatements(page.pageItemId, epoch)).toEqual([]);
    // The nested page of that epoch is still in the Trash: the host hook left the page's subpages to the page hook.
    expect(await liveStates(nested.pageItemId)).toEqual([false]);
  });

  it("returns after one read when the tenant has no Pages database", async () => {
    const project = await createProject();
    await trash(project);
    const epoch = await trashEpochOf(project);

    const onDelete = await deleteHookStatements(project);
    const onRestore = await restoreHookStatements(project, epoch);

    expect(onDelete).toHaveLength(1);
    expect(onDelete[0]).toMatch(READS_PAGES_DATABASE);
    expect(onRestore).toHaveLength(1);
    expect(onRestore[0]).toMatch(READS_PAGES_DATABASE);
  });

  it("returns after two reads and no write for a host without a subpage to act on", async () => {
    // Another project holds a subpage, so the tenant has a Pages database.
    const other = await createProject("With a page");
    const otherPage = await createSubpage(other, "Kept");
    const project = await createProject("Plain");
    await trash(project);
    const epoch = await trashEpochOf(project);

    const onDelete = await deleteHookStatements(project);
    const onRestore = await restoreHookStatements(project, epoch);

    expect(onDelete).toHaveLength(2);
    expect(onDelete[0]).toMatch(READS_PAGES_DATABASE);
    expect(onDelete[1]).toMatch(LOCKS_LIVE_SUBPAGES);
    expect(onRestore).toHaveLength(2);
    expect(onRestore[0]).toMatch(READS_PAGES_DATABASE);
    expect(onRestore[1]).toMatch(LOCKS_EPOCH_SUBPAGES);
    expect([...onDelete, ...onRestore].filter((text) => WRITES.test(text))).toEqual([]);
    expect(await liveStates(other, otherPage.pageItemId)).toEqual([true, true]);
  });

  it("reads no deletion epoch for a page without live subpages", async () => {
    const project = await createProject();
    const page = await createSubpage(project, "Release checklist");
    await trash(page.pageItemId);

    const { statements, error } = await pageDeleteHookStatements(page.pageItemId);

    expect(error).toBeNull();
    expect(statements[0]).toMatch(LOCKS_LIVE_SUBPAGES);
    expect(statements.filter((text) => READS_TRASH_EPOCH.test(text))).toEqual([]);
  });

  it("refuses to trash the pages below a page that has no deletion epoch", async () => {
    const project = await createProject();
    const page = await createSubpage(project, "Release checklist");
    const nested = await createSubpage(page.pageItemId, "Notes");

    // The cascade calls the hook after the page's soft delete only; a live page here stands for a broken caller.
    const { error } = await pageDeleteHookStatements(page.pageItemId);

    expect(error).toEqual(new Error(`Trashed page ${page.pageItemId} has no deletion epoch`));
    expect(await liveStates(project, page.pageItemId, nested.pageItemId)).toEqual([true, true, true]);
  });

  it("refuses to trash the subpages of a row that has no deletion epoch", async () => {
    const project = await createProject();
    const page = await createSubpage(project, "Release checklist");

    // The cascade calls the hook after the row's soft delete only; a live row here stands for a broken caller.
    await expect(deleteHookStatements(project)).rejects.toThrow(`Trashed host ${project} has no deletion epoch`);

    expect(await liveStates(project, page.pageItemId)).toEqual([true, true]);
    expect(pageBlocks(await readDocument(project)).map((block) => block.pageId)).toEqual([page.pageItemId]);
  });
});
