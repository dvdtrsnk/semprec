import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { withTransaction } from "../../db/pool.js";
import { createSubpageWithClient, renamePageWithClient } from "../../docs/pageOperations.js";
import { MAX_SUBPAGE_CHAIN } from "../../docs/pageOwnerDatabase.js";
import { ensurePagesDatabase } from "../../docs/pagesDatabase.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createTrashItemsRouteHandler } from "../trashRouteHandlers.js";

let adminPool: Pool;
let dataPool: Pool;
let chokePoint: ChokePoint;
let tenantId: string;
let otherTenantId: string;

const ancestorSchema = z.object({ itemId: z.string(), title: z.string(), trashed: z.boolean() }).strict();
const rowSchema = z
  .object({
    item: z.object({ id: z.string(), databaseId: z.string(), properties: z.record(z.string(), z.unknown()) }).loose(),
    databaseKey: z.string().nullable(),
    ownerModuleId: z.string().nullable(),
    databaseName: z.string(),
    page: z
      .object({ title: z.string(), path: z.array(ancestorSchema) })
      .strict()
      .optional(),
  })
  .loose();
const bodySchema = z
  .object({ items: z.array(rowSchema), totalCount: z.number(), nextCursor: z.string().nullable() })
  .strict();
type Body = z.infer<typeof bodySchema>;

/** Calls the handler as the adapter does: inside the tenant's scope, with the request URL and the caller's locale. */
async function list(query = "", options: { tenant?: string; locale?: string } = {}): Promise<Body> {
  const result = await runInTenant(options.tenant ?? tenantId, () =>
    createTrashItemsRouteHandler(dataPool)({
      req: { url: `/api/trash/items${query}` },
      identity: { user: { locale: options.locale ?? "en" } },
    }),
  );
  expect(result.status).toBe(200);
  return bodySchema.parse(JSON.parse(JSON.stringify(result.body)));
}

const ids = (body: Body): string[] => body.items.map((row) => row.item.id);

function inTenant<T>(fn: (client: PoolClient) => Promise<T>, tenant = tenantId): Promise<T> {
  return runInTenant(tenant, () => withTransaction(dataPool, fn));
}

/** A new item of the system database of `moduleId`, written through the choke point. */
async function moduleItem(moduleId: string, properties: Record<string, unknown>, tenant = tenantId): Promise<string> {
  return runInTenant(tenant, async () => {
    const database = (await chokePoint.listDatabases()).find(
      (candidate) => candidate.system && candidate.ownerModuleId === moduleId,
    );
    if (!database) throw new Error(`Missing the ${moduleId} database`);
    return (await chokePoint.createItem({ databaseId: database.id, properties })).id;
  });
}

const createProject = (name: string, tenant = tenantId): Promise<string> => moduleItem("projects", { name }, tenant);

/** A subpage of `parentItemId` (a host item or a page), created by the page operation like production does. */
async function createPage(parentItemId: string, title: string, tenant = tenantId): Promise<string> {
  const created = await inTenant(
    (client) => createSubpageWithClient(client, { parent: { itemId: parentItemId }, title }, "user"),
    tenant,
  );
  const page = created.pages[0];
  if (!page) throw new Error("Missing created page");
  return page.pageItemId;
}

async function renamePage(pageItemId: string, title: string): Promise<void> {
  await inTenant((client) => renamePageWithClient(client, { pageItemId, title }, "user"));
}

/** Trashes an item the way the application service does: resolve its database, then the choke point's cascade. */
async function trash(itemId: string, tenant = tenantId): Promise<void> {
  await runInTenant(tenant, async () => {
    const item = await chokePoint.findItemIncludingDeleted(itemId);
    if (!item) throw new Error(`Item ${itemId} does not exist`);
    await chokePoint.softDeleteItem(item.databaseId, itemId);
  });
}

/**
 * Raw SQL on the superuser pool for a stored state the page operations refuse to create (a link that is not an id,
 * a cycle, a title that is not text): the item's `properties` gets `patch` merged in.
 */
async function forceProperties(itemId: string, patch: Record<string, unknown>): Promise<void> {
  const result = await adminPool.query("UPDATE items SET properties = properties || $2::jsonb WHERE id = $1", [
    itemId,
    JSON.stringify(patch),
  ]);
  expect(result.rowCount).toBe(1);
}

function pageOf(body: Body, itemId: string): NonNullable<Body["items"][number]["page"]> {
  const page = body.items.find((row) => row.item.id === itemId)?.page;
  if (!page) throw new Error(`Row ${itemId} has no page object`);
  return page;
}

describe("GET /api/trash/items with pages (issue gh-1855)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    chokePoint = createChokePoint(dataPool);
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantId = await createTestTenant(adminPool);
    otherTenantId = await createTestTenant(adminPool);
    await runInTenant(tenantId, () => seedSystem(dataPool));
    await runInTenant(otherTenantId, () => seedSystem(dataPool));
  });

  afterAll(async () => {
    const results = await Promise.allSettled([dataPool?.end(), adminPool?.end()]);
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (errors.length) throw new AggregateError(errors, "Pool cleanup failed", { cause: errors[0] });
  });

  it("gives a deleted subpage with two nested pages one row with its title and the chain of its ancestors, and no row for the nested pages", async () => {
    const project = await createProject("Website");
    const notes = await createPage(project, "Notes");
    const checklist = await createPage(notes, "Release checklist");
    const nestedA = await createPage(checklist, "Step A");
    const nestedB = await createPage(checklist, "Step B");
    await trash(checklist);

    const body = await list();

    expect(ids(body)).toEqual([checklist]);
    expect(body.totalCount).toBe(1);
    expect(body.nextCursor).toBeNull();
    expect(ids(body)).not.toContain(nestedA);
    expect(ids(body)).not.toContain(nestedB);
    const [row] = body.items;
    expect(row).toMatchObject({ databaseKey: "pages", ownerModuleId: "pages", databaseName: "Pages" });
    expect(row?.page).toEqual({
      title: "Release checklist",
      path: [
        { itemId: project, title: "Website", trashed: false },
        { itemId: notes, title: "Notes", trashed: false },
      ],
    });
  });

  it("names the hidden database in the caller's locale and keeps its key and owner module", async () => {
    const project = await createProject("Website");
    const page = await createPage(project, "Notes");
    await trash(page);

    const body = await list("", { locale: "cs" });

    expect(body.items.map((row) => row.databaseName)).toEqual(["Stránky"]);
    expect(body.items[0]).toMatchObject({ databaseKey: "pages", ownerModuleId: "pages" });
  });

  it("lists only the project when a project with subpages is deleted, and gives the project row no page object", async () => {
    const project = await createProject("Website");
    const notes = await createPage(project, "Notes");
    const nested = await createPage(notes, "Release checklist");
    const other = await createPage(project, "Roadmap");
    await trash(project);

    const body = await list();

    expect(ids(body)).toEqual([project]);
    expect(body.totalCount).toBe(1);
    expect(ids(body)).not.toContain(notes);
    expect(ids(body)).not.toContain(nested);
    expect(ids(body)).not.toContain(other);
    expect(body.items[0]?.page).toBeUndefined();
    expect(body.items[0]).toMatchObject({ databaseKey: "projects" });
  });

  it("gives a nested page that was trashed on its own before its parent a row of its own, with the trashed parent in its path", async () => {
    const project = await createProject("Website");
    const parent = await createPage(project, "Notes");
    const child = await createPage(parent, "Release checklist");
    const grandchild = await createPage(child, "Step A");
    const sibling = await createPage(parent, "Roadmap");
    await trash(child);
    await trash(parent);

    const body = await list();

    // The parent was trashed last, so it is first; its live sibling went with it, the child kept its own epoch.
    expect(ids(body)).toEqual([parent, child]);
    expect(body.totalCount).toBe(2);
    expect(ids(body)).not.toContain(grandchild);
    expect(ids(body)).not.toContain(sibling);
    expect(pageOf(body, parent)).toEqual({
      title: "Notes",
      path: [{ itemId: project, title: "Website", trashed: false }],
    });
    expect(pageOf(body, child)).toEqual({
      title: "Release checklist",
      path: [
        { itemId: project, title: "Website", trashed: false },
        { itemId: parent, title: "Notes", trashed: true },
      ],
    });
  });

  it("shows the new title of a renamed page and of a renamed ancestor", async () => {
    const project = await createProject("Website");
    const notes = await createPage(project, "Notes");
    const page = await createPage(notes, "Draft");
    await renamePage(notes, "Meeting notes");
    await renamePage(page, "Release checklist");
    await trash(page);

    const body = await list();

    expect(pageOf(body, page)).toEqual({
      title: "Release checklist",
      path: [
        { itemId: project, title: "Website", trashed: false },
        { itemId: notes, title: "Meeting notes", trashed: false },
      ],
    });
  });

  it("keeps ordering, paging and totalCount over a result made of page rows, other rows and skipped pages", async () => {
    const project = await createProject("Website");
    const projectPages = [await createPage(project, "Notes"), await createPage(project, "Roadmap")];
    const standalone = await createProject("Alone");
    const lonePage = await createPage(standalone, "Lone page");
    const nestedParent = await createPage(standalone, "Outer");
    const nestedChild = await createPage(nestedParent, "Inner");
    const task = await moduleItem("tasks", { name: "Pay rent" });
    // Trashed one after the other, so the list is the reverse of this order.
    await trash(project);
    await trash(lonePage);
    await trash(nestedParent);
    await trash(task);
    await trash(standalone);
    const expected = [standalone, task, nestedParent, lonePage, project];

    const seen: string[] = [];
    const totals: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const body: Body = await list(`?limit=2${cursor === null ? "" : `&cursor=${cursor}`}`);
      seen.push(...ids(body));
      totals.push(body.totalCount);
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);

    expect(seen).toEqual(expected);
    expect(totals).toEqual([5, 5, 5]);
    expect(pages).toBe(3);
    for (const skipped of [...projectPages, nestedChild]) expect(seen).not.toContain(skipped);
    const all = await list();
    expect(all.items.map((row) => row.page !== undefined)).toEqual([false, false, true, true, false]);
  });

  it("gives a tenant only the trashed pages of its own", async () => {
    const project = await createProject("Website");
    const page = await createPage(project, "Notes");
    await trash(page);
    const otherProject = await createProject("Other website", otherTenantId);
    const otherPage = await createPage(otherProject, "Other notes", otherTenantId);
    await trash(otherPage, otherTenantId);

    const own = await list();
    const other = await list("", { tenant: otherTenantId });

    expect(ids(own)).toEqual([page]);
    expect(own.totalCount).toBe(1);
    expect(ids(other)).toEqual([otherPage]);
    expect(other.totalCount).toBe(1);
    expect(pageOf(other, otherPage).path).toEqual([{ itemId: otherProject, title: "Other website", trashed: false }]);
  });

  it("ends the path at the host, whose own database parents are not part of it", async () => {
    const project = await createProject("Website");
    const inlineDatabase = await runInTenant(tenantId, async () => {
      return (await chokePoint.createInlineDatabase({ name: "Milestones", parentItemId: project })).id;
    });
    const milestone = await runInTenant(tenantId, async () => {
      return (await chokePoint.createItem({ databaseId: inlineDatabase, properties: {} })).id;
    });
    const page = await createPage(milestone, "Plan");
    await trash(page);

    const body = await list();

    // The host has no title-typed value here, which reads as the empty title; the project above it is not listed.
    expect(pageOf(body, page).path).toEqual([{ itemId: milestone, title: "", trashed: false }]);
  });

  it("lists a page with an empty path when its link names no item, is not an id or is missing", async () => {
    const project = await createProject("Website");
    const gone = await createPage(project, "Link to a purged item");
    const malformed = await createPage(project, "Link that is not an id");
    const missing = await createPage(project, "No link");
    await forceProperties(gone, { parentItemId: randomUUID() });
    await forceProperties(malformed, { parentItemId: "not-a-uuid" });
    await adminPool.query("UPDATE items SET properties = properties - 'parentItemId' WHERE id = $1", [missing]);
    await trash(gone);
    await trash(malformed);
    await trash(missing);

    const body = await list();

    expect(new Set(ids(body))).toEqual(new Set([gone, malformed, missing]));
    for (const id of [gone, malformed, missing]) expect(pageOf(body, id).path).toEqual([]);
  });

  it("stops the walk at an item it has already seen when the stored links form a cycle", async () => {
    const project = await createProject("Website");
    const outer = await createPage(project, "Outer");
    const inner = await createPage(outer, "Inner");
    await trash(inner);
    // The page operations refuse a cycle, so the stored state is forced: outer now names inner as its parent.
    await forceProperties(outer, { parentItemId: inner });

    const body = await list();

    expect(ids(body)).toEqual([inner]);
    expect(pageOf(body, inner).path).toEqual([{ itemId: outer, title: "Outer", trashed: false }]);
  });

  it("keeps the nearest 1000 ancestors of a page under a chain deeper than the bound, and all of a chain of exactly 1000", async () => {
    const project = await createProject("Website");
    const head = await createPage(project, "Head");
    const pages = await runInTenant(tenantId, () => inTenant((client) => ensurePagesDatabase(client)));
    // A 1100-deep chain would take 1100 API calls; this superuser insert builds it with one statement. Page 1's parent
    // is the head, so page n has the ancestors p(n-1) .. p1, the head and the project: n + 1 of them.
    const { rows } = await adminPool.query<{ id: string; label: string }>(
      `WITH chain AS (
         SELECT n, gen_random_uuid() AS id FROM generate_series(1, 1100) AS n
       ), linked AS (
         SELECT c.n, c.id, COALESCE(p.id::text, $2::text) AS parent FROM chain c LEFT JOIN chain p ON p.n = c.n - 1
       )
       INSERT INTO items (id, tenant_id, database_id, properties)
       SELECT id, $3::uuid, $1, jsonb_build_object('title', 'p' || n, 'parentItemId', parent) FROM linked
       RETURNING id, properties->>'title' AS label`,
      [pages.id, head, tenantId],
    );
    const byLabel = new Map(rows.map((row) => [row.label, row.id]));
    const idOf = (label: string): string => {
      const id = byLabel.get(label);
      if (!id) throw new Error(`Missing ${label}`);
      return id;
    };
    // p999 has exactly 1000 ancestors (p998 .. p1, the head, the project), p1100 has 1101.
    await adminPool.query("UPDATE items SET deleted_at = now() WHERE id = ANY($1::uuid[])", [
      [idOf("p999"), idOf("p1100")],
    ]);

    const body = await list();

    const exact = pageOf(body, idOf("p999")).path;
    expect(exact).toHaveLength(MAX_SUBPAGE_CHAIN);
    expect(exact[0]).toEqual({ itemId: project, title: "Website", trashed: false });
    expect(exact[1]).toEqual({ itemId: head, title: "Head", trashed: false });
    expect(exact.at(-1)).toEqual({ itemId: idOf("p998"), title: "p998", trashed: false });
    // The cut is at the root end: the project, the head and p1 .. p99 are dropped, the nearest 1000 ancestors stay.
    const deep = pageOf(body, idOf("p1100")).path;
    expect(deep).toHaveLength(MAX_SUBPAGE_CHAIN);
    expect(deep[0]).toEqual({ itemId: idOf("p100"), title: "p100", trashed: false });
    expect(deep.at(-1)).toEqual({ itemId: idOf("p1099"), title: "p1099", trashed: false });
    expect(deep.map((ancestor) => ancestor.itemId)).not.toContain(project);
  });

  it("reads a title that is not text as the empty title", async () => {
    const project = await createProject("Website");
    const page = await createPage(project, "Notes");
    await forceProperties(page, { title: 5 });
    await trash(page);

    const body = await list();

    expect(pageOf(body, page).title).toBe("");
  });

  it("sends no page object for a trashed item of a database other than Pages", async () => {
    const task = await moduleItem("tasks", { name: "Pay rent" });
    await trash(task);

    const body = await list();

    expect(ids(body)).toEqual([task]);
    expect(body.items[0]?.page).toBeUndefined();
  });
});
