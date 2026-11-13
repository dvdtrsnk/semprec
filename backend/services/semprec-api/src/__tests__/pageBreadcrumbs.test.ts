import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import * as Y from "yjs";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import {
  createApiCoreTaskList,
  createChokePoint,
  createDocStore,
  loadFullModuleRegistry,
  mutateYDoc,
  seedSystem,
} from "@semprec/data";
import { runOnce } from "@semprec/queue";
import { createApiActionRegistry } from "../actionRegistryComposition.js";
import { PageHttpHarness } from "./pageHttpHarness.js";

const harness = new PageHttpHarness();
const moduleRegistry = await loadFullModuleRegistry();

const crumbs = z.array(
  z.object({
    itemId: z.string(),
    title: z.string(),
    databaseKey: z.string().nullable(),
    journal: z.object({ type: z.string(), period: z.string() }).optional(),
  }),
);
const pageBody = z.object({ breadcrumbs: crumbs.nullable() });

interface Subpage {
  pageItemId: string;
  blockId: string;
}

async function get(path: string, headers = harness.headersA): Promise<Response> {
  return fetch(`${harness.baseUrl}${path}`, { headers });
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${harness.baseUrl}${path}`, {
    method: "POST",
    headers: { ...harness.headersA, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A project-like host with a title property named `name`, in tenant A. */
async function titledHost(title: string): Promise<string> {
  return runInTenant(harness.tenantA, async () => {
    const chokePoint = createChokePoint(harness.runtime);
    const database = await chokePoint.createDatabase({ name: `Projects ${randomUUID()}` });
    await chokePoint.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "title" });
    return (await chokePoint.createItem({ databaseId: database.id, properties: { name: title } })).id;
  });
}

async function subpage(parent: string, title: string): Promise<Subpage> {
  const response = await post(`/api/items/${parent}/page/subpages`, { title });
  expect(response.status, await response.clone().text()).toBe(201);
  const created = z
    .object({ pages: z.array(z.object({ pageItemId: z.string(), blockId: z.string() })).length(1) })
    .parse(await response.json());
  const page = created.pages[0];
  if (!page) throw new Error("Missing page");
  return page;
}

async function breadcrumbsOf(itemId: string): Promise<z.infer<typeof crumbs> | null> {
  const response = await get(`/api/items/${itemId}/page`);
  expect(response.status).toBe(200);
  return pageBody.parse(await response.json()).breadcrumbs;
}

describe("breadcrumbs of subpages (issue #2014)", () => {
  beforeAll(() => harness.start());
  beforeEach(() => harness.reset());
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => harness.stop());

  it("shows the host and the parent pages with their titles for a nested subpage", async () => {
    const project = await titledHost("Release project");
    const checklist = await subpage(project, "Release checklist");
    const notes = await subpage(checklist.pageItemId, "Notes for version 0.4");

    const trail = await breadcrumbsOf(notes.pageItemId);

    expect(trail?.map(({ itemId, title }) => [itemId, title])).toEqual([
      [project, "Release project"],
      [checklist.pageItemId, "Release checklist"],
      [notes.pageItemId, "Notes for version 0.4"],
    ]);
    expect(trail?.map((crumb) => crumb.databaseKey)).toEqual([null, "pages", "pages"]);
    expect(trail?.every((crumb) => crumb.journal === undefined)).toBe(true);
    // The one-level case and the item path of the REST item read agree with it.
    expect((await breadcrumbsOf(checklist.pageItemId))?.map((crumb) => crumb.title)).toEqual([
      "Release project",
      "Release checklist",
    ]);
    const path = z
      .object({ path: z.array(z.object({ id: z.string() })) })
      .parse(await (await get(`/api/items/${notes.pageItemId}?include=path`)).json());
    expect(path.path.map((entry) => entry.id)).toEqual([project, checklist.pageItemId, notes.pageItemId]);
  });

  it("starts with the Journal day, carrying its journal metadata, for a subpage under a day", async () => {
    await runInTenant(harness.tenantA, () => seedSystem(harness.runtime));
    const ensured = await fetch(`${harness.baseUrl}/api/journal/periods/day/2026-10-16/doc`, {
      method: "PUT",
      headers: { ...harness.headersA, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(ensured.status).toBe(200);
    const day = z.object({ itemId: z.string() }).parse(await ensured.json());
    const page = await subpage(day.itemId, "Plan of the day");

    const trail = await breadcrumbsOf(page.pageItemId);

    expect(trail).toHaveLength(2);
    expect(trail?.[0]).toMatchObject({ itemId: day.itemId, journal: { type: "day", period: "2026-10-16" } });
    expect(trail?.[1]).toMatchObject({ itemId: page.pageItemId, title: "Plan of the day", databaseKey: "pages" });
    expect(trail?.[1]?.journal).toBeUndefined();
  });

  it("ends the walk, and still answers 200, when stored parentItemId values form a cycle", async () => {
    const project = await titledHost("Cycle host");
    const first = await subpage(project, "First");
    const second = await subpage(first.pageItemId, "Second");
    // The API never reparents a page, so a cycle cannot be built through it; this superuser write stands in for
    // corrupted data, the case the walk must survive.
    await harness.admin.query(
      `UPDATE items SET properties = jsonb_set(properties, '{parentItemId}', to_jsonb($2::text)) WHERE id = $1`,
      [first.pageItemId, second.pageItemId],
    );

    const trail = await breadcrumbsOf(second.pageItemId);

    expect(trail?.map((crumb) => crumb.itemId)).toEqual([first.pageItemId, second.pageItemId]);
    expect(new Set(trail?.map((crumb) => crumb.itemId)).size).toBe(trail?.length);
  });

  it("cuts a very long stored chain at 1000 elements instead of walking it all", async () => {
    const project = await titledHost("Long chain host");
    const head = await subpage(project, "Head");
    const pagesDatabase = await harness.admin.query<{ database_id: string }>(
      `SELECT database_id FROM items WHERE id = $1`,
      [head.pageItemId],
    );
    const databaseId = pagesDatabase.rows[0]?.database_id;
    // A 1200-page chain would take 1200 API calls; one superuser statement builds it. Page n's parent is page n - 1.
    const chain = await harness.admin.query<{ id: string; label: string }>(
      `WITH chain AS (SELECT n, gen_random_uuid() AS id FROM generate_series(1, 1200) AS n),
            linked AS (SELECT c.n, c.id, COALESCE(p.id::text, $2::text) AS parent FROM chain c LEFT JOIN chain p ON p.n = c.n - 1)
       INSERT INTO items (id, database_id, tenant_id, properties)
       SELECT id, $1, $3, jsonb_build_object('title', 'p' || n, 'parentItemId', parent) FROM linked
       RETURNING id, properties->>'title' AS label`,
      [databaseId, head.pageItemId, harness.tenantA],
    );
    const tail = chain.rows.find((row) => row.label === "p1200")?.id;
    if (!tail) throw new Error("Missing chain tail");

    const trail = await breadcrumbsOf(tail);

    expect(trail).toHaveLength(1000);
    expect(trail?.at(-1)?.itemId).toBe(tail);
  });

  it("composes the trail from item state alone: no document of any ancestor is read", async () => {
    const project = await titledHost("Doc-free host");
    const checklist = await subpage(project, "Checklist");
    const notes = await subpage(checklist.pageItemId, "Notes");
    await runInTenant(harness.tenantA, () => createDocStore(harness.runtime).getOrCreateDoc(project, "page"));
    const ancestorDocs = (
      await harness.admin.query<{ id: string }>(`SELECT id FROM docs WHERE item_id = ANY($1::uuid[])`, [
        [project, checklist.pageItemId],
      ])
    ).rows.map((row) => row.id);
    expect(ancestorDocs).toHaveLength(2);

    const statements: string[] = [];
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original: (this: pg.Client, ...args: unknown[]) => unknown = pg.Client.prototype.query;
    vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      const first = args[0];
      const text =
        typeof first === "string"
          ? first
          : typeof first === "object" && first !== null && "text" in first
            ? first.text
            : undefined;
      const params = Array.isArray(args[1]) ? JSON.stringify(args[1]) : "";
      if (typeof text === "string" && /\b(docs|doc_snapshots|doc_updates)\b/.test(text))
        statements.push(`${text} ${params}`);
      return original.apply(this, args);
    });

    const trail = await breadcrumbsOf(notes.pageItemId);

    expect(trail).toHaveLength(3);
    // The page's own document is read for its summary; no statement names an ancestor's document or item.
    for (const statement of statements) {
      for (const ancestor of [...ancestorDocs, project, checklist.pageItemId])
        expect(statement).not.toContain(ancestor);
    }
  });

  it("answers another tenant's page exactly like an unknown id, with 404", async () => {
    const project = await titledHost("Mine");
    const page = await subpage(project, "Private page");
    const unknown = randomUUID();
    const foreign = await get(`/api/items/${page.pageItemId}/page`, harness.headersB);
    const missing = await get(`/api/items/${unknown}/page`, harness.headersB);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect((await foreign.text()).replaceAll(page.pageItemId, "<id>")).toBe(
      (await missing.text()).replaceAll(unknown, "<id>"),
    );
  });
});

describe("mirrored titles reach breadcrumbs and the trash (issue #1715)", () => {
  // `createApiActionRegistry` reads the internal AI gateway token to build the guidance action; the value is a placeholder
  // and no gateway is called (the same setup `actionRegistryComposition.test.ts` uses).
  const originalToken = process.env.AI_GATEWAY_INTERNAL_TOKEN;
  beforeAll(async () => {
    process.env.AI_GATEWAY_INTERNAL_TOKEN = "test-internal-token";
    await harness.start();
  });
  beforeEach(() => harness.reset());
  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    try {
      await harness.stop();
    } finally {
      if (originalToken === undefined) delete process.env.AI_GATEWAY_INTERNAL_TOKEN;
      else process.env.AI_GATEWAY_INTERNAL_TOKEN = originalToken;
    }
  });

  it("reads the retitled page in its breadcrumbs and in the trash list once the mirror job has run", async () => {
    // Edits are written 60 seconds in the past, so their 10-second debounce has elapsed when the queue is drained.
    // Only `Date` is faked; the database clock and Graphile Worker's polling are untouched.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 60_000);
    const project = await titledHost("Mirror host");
    const page = await subpage(project, "Before");
    const hostDoc = await harness.docIdOf(harness.tenantA, project);
    await runInTenant(harness.tenantA, () =>
      mutateYDoc(harness.runtime, hostDoc, "user", (ydoc) => {
        const title = ydoc.getMap<Y.Map<unknown>>("blocks").get(page.blockId)?.get("text");
        if (!(title instanceof Y.Text)) throw new Error("expected the page block title to be a Y.Text");
        title.delete(0, title.length);
        title.insert(0, "After");
      }),
    );
    vi.useRealTimers();
    const taskList = createApiCoreTaskList(harness.runtime, createApiActionRegistry(harness.runtime, moduleRegistry));
    const handler = taskList.pageTitleMirror;
    if (!handler) throw new Error("The mirror handler is missing from the production API task list");
    await runOnce({ pgPool: harness.admin }, { pageTitleMirror: handler });

    expect((await breadcrumbsOf(page.pageItemId))?.map((crumb) => crumb.title)).toEqual(["Mirror host", "After"]);

    const trashed = await fetch(`${harness.baseUrl}/api/items/${page.pageItemId}`, {
      method: "DELETE",
      headers: harness.headersA,
    });
    expect(trashed.status).toBe(200);
    const pagesDatabaseId = (
      await harness.admin.query<{ database_id: string }>(`SELECT database_id FROM items WHERE id = $1`, [
        page.pageItemId,
      ])
    ).rows[0]?.database_id;
    const trash = await fetch(`${harness.baseUrl}/api/databases/${pagesDatabaseId}/query`, {
      method: "POST",
      headers: { ...harness.headersA, "Content-Type": "application/json" },
      body: JSON.stringify({ inTrash: true }),
    });
    expect(trash.status).toBe(200);
    const listed = z
      .object({ items: z.array(z.object({ id: z.string(), properties: z.record(z.string(), z.unknown()) })) })
      .parse(await trash.json());
    expect(listed.items.map((item) => [item.id, item.properties.title])).toEqual([[page.pageItemId, "After"]]);
  });

  it("keeps the one-element trail of a page whose parent is trashed or missing", async () => {
    const project = await titledHost("Orphan host");
    const trashedParent = await subpage(project, "Under a trashed parent");
    const missingParent = await subpage(project, "Under a missing parent");
    // The API never reparents a page; this superuser write stands in for a parent that is gone.
    await harness.admin.query(
      `UPDATE items SET properties = jsonb_set(properties, '{parentItemId}', to_jsonb($2::text)) WHERE id = $1`,
      [missingParent.pageItemId, randomUUID()],
    );
    const trashed = await fetch(`${harness.baseUrl}/api/items/${project}`, {
      method: "DELETE",
      headers: harness.headersA,
    });
    expect(trashed.status).toBe(200);
    // The project's trash took its subpage with it (issue #1763). Restored on its own, the page is live below the
    // trashed project.
    const restored = await fetch(`${harness.baseUrl}/api/items/${trashedParent.pageItemId}/restore`, {
      method: "POST",
      headers: harness.headersA,
    });
    expect(restored.status).toBe(200);
    expect((await get(`/api/items/${project}`)).status).toBe(404);

    for (const [page, title] of [
      [trashedParent, "Under a trashed parent"],
      [missingParent, "Under a missing parent"],
    ] as const) {
      expect(await breadcrumbsOf(page.pageItemId), title).toEqual([
        { itemId: page.pageItemId, title, databaseKey: "pages" },
      ]);
    }
  });

  it("reports subpageCount 2 for a project with two subpages through GET /page", async () => {
    const project = await titledHost("Counted host");
    await subpage(project, "One");
    await subpage(project, "Two");

    const response = await get(`/api/items/${project}/page`);

    expect(response.status).toBe(200);
    expect(z.object({ subpageCount: z.number() }).parse(await response.json()).subpageCount).toBe(2);
  });
});
