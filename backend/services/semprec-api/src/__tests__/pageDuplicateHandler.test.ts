import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { createChokePoint } from "@semprec/data";
import { PageHttpHarness } from "./pageHttpHarness.js";

const harness = new PageHttpHarness();

const createdBody = z.object({
  pages: z.array(z.object({ pageItemId: z.string(), docId: z.string(), blockId: z.string() })).length(1),
});
const copyBody = z.object({ pageItemId: z.string(), docId: z.string(), blockId: z.string() }).strict();
const insertedBody = z.object({ blockIds: z.array(z.string()) });
const pageBody = z.object({
  docId: z.string().nullable(),
  subpageCount: z.number(),
  blocks: z.array(z.object({ id: z.string(), type: z.string(), text: z.string(), pageId: z.string().optional() })),
  breadcrumbs: z.array(z.object({ itemId: z.string(), title: z.string() })).nullable(),
});
const errorBody = z.object({
  error: z.object({ code: z.string(), details: z.record(z.string(), z.unknown()).optional() }),
});

interface Answer {
  status: number;
  text: string;
}

async function request(
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<Answer> {
  const response = await fetch(`${harness.baseUrl}${path}`, {
    method,
    headers: {
      ...(options.headers ?? harness.headersA),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, text: await response.text() };
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

async function subpage(parent: string, title: string): Promise<{ pageItemId: string; blockId: string }> {
  const created = await request("POST", `/api/items/${parent}/page/subpages`, { body: { title } });
  expect(created.status, created.text).toBe(201);
  const page = createdBody.parse(JSON.parse(created.text)).pages[0];
  if (!page) throw new Error("Missing page");
  return page;
}

async function insertMarkdown(itemId: string, markdown: string): Promise<string[]> {
  const inserted = await request("POST", `/api/items/${itemId}/page/insert`, { body: { placement: "end", markdown } });
  expect(inserted.status, inserted.text).toBe(200);
  return insertedBody.parse(JSON.parse(inserted.text)).blockIds;
}

async function pageOf(itemId: string): Promise<z.infer<typeof pageBody>> {
  const read = await request("GET", `/api/items/${itemId}/page`);
  expect(read.status, read.text).toBe(200);
  return pageBody.parse(JSON.parse(read.text));
}

function duplicate(pageItemId: string, headers?: Record<string, string>): Promise<Answer> {
  return request("POST", `/api/items/${pageItemId}/page/duplicate`, { headers });
}

interface Stored {
  pagesItems: number;
  docs: number;
  docUpdates: number;
}

/** Everything a duplicate creates, counted in tenant A: what a refused call must leave as it found it. */
async function stored(): Promise<Stored> {
  const { rows } = await runInTenant(harness.tenantA, () =>
    harness.runtime.query<Stored>(
      `SELECT (SELECT count(*)::int FROM items i JOIN databases d ON d.id = i.database_id WHERE d.key = 'pages') AS "pagesItems",
              (SELECT count(*)::int FROM docs) AS docs,
              (SELECT count(*)::int FROM doc_updates) AS "docUpdates"`,
    ),
  );
  const row = rows[0];
  if (!row) throw new Error("Missing counts");
  return row;
}

describe("POST /api/items/:id/page/duplicate (issue #1722)", () => {
  beforeAll(() => harness.start());
  beforeEach(() => harness.reset());
  afterAll(() => harness.stop());

  it("creates 'Release checklist (kopie)' next to the original with its own copy of the nested page", async () => {
    const project = await titledHost("Release project");
    const checklist = await subpage(project, "Release checklist");
    const notes = await subpage(checklist.pageItemId, "Notes for 0.4");
    await insertMarkdown(notes.pageItemId, "A note");
    const originalReads = [
      `/api/items/${checklist.pageItemId}/page`,
      `/api/items/${notes.pageItemId}/page`,
      `/api/items/${checklist.pageItemId}/page.md`,
      `/api/items/${notes.pageItemId}/page.md`,
      `/api/items/${checklist.pageItemId}`,
      `/api/items/${notes.pageItemId}`,
    ];
    const readOriginals = (): Promise<Answer[]> => Promise.all(originalReads.map((path) => request("GET", path)));
    const before = await readOriginals();
    expect(before.map((answer) => answer.status)).toEqual(originalReads.map(() => 200));

    const answer = await duplicate(checklist.pageItemId);

    expect(answer.status, answer.text).toBe(201);
    const copy = copyBody.parse(JSON.parse(answer.text));
    // New users have the locale `cs`, so the root of the copy carries the Czech suffix.
    const parent = await pageOf(project);
    expect(parent.subpageCount).toBe(2);
    expect(parent.blocks).toEqual([
      { id: checklist.blockId, type: "page", text: "Release checklist", pageId: checklist.pageItemId },
      { id: copy.blockId, type: "page", text: "Release checklist (kopie)", pageId: copy.pageItemId },
    ]);
    const copied = await pageOf(copy.pageItemId);
    expect(copied.docId).toBe(copy.docId);
    expect(copied.blocks).toMatchObject([{ type: "page", text: "Notes for 0.4" }]);
    const nestedCopyId = copied.blocks[0]?.pageId;
    if (!nestedCopyId) throw new Error("The copy has no nested page block");
    expect([checklist.pageItemId, notes.pageItemId, copy.pageItemId]).not.toContain(nestedCopyId);
    const nestedCopy = await pageOf(nestedCopyId);
    expect(nestedCopy.blocks).toMatchObject([{ type: "text", text: "A note" }]);
    expect(nestedCopy.breadcrumbs?.map((crumb) => [crumb.itemId, crumb.title])).toEqual([
      [project, "Release project"],
      [copy.pageItemId, "Release checklist (kopie)"],
      [nestedCopyId, "Notes for 0.4"],
    ]);
    // The original pages, their documents and their items read exactly as before.
    expect(await readOriginals()).toEqual(before);
  });

  it("does not change the original's nested page when the copy's nested page is edited", async () => {
    const project = await titledHost("Release project");
    const checklist = await subpage(project, "Release checklist");
    const notes = await subpage(checklist.pageItemId, "Notes");
    await insertMarkdown(notes.pageItemId, "Original note");
    const copy = copyBody.parse(JSON.parse((await duplicate(checklist.pageItemId)).text));
    const nestedCopyId = (await pageOf(copy.pageItemId)).blocks[0]?.pageId;
    if (!nestedCopyId) throw new Error("The copy has no nested page block");
    const originalBefore = await request("GET", `/api/items/${notes.pageItemId}/page.md`);
    expect(originalBefore.status, originalBefore.text).toBe(200);

    await insertMarkdown(nestedCopyId, "Only in the copy");

    expect((await pageOf(nestedCopyId)).blocks.map((block) => block.text)).toEqual([
      "Original note",
      "Only in the copy",
    ]);
    expect((await pageOf(notes.pageItemId)).blocks.map((block) => block.text)).toEqual(["Original note"]);
    expect(await request("GET", `/api/items/${notes.pageItemId}/page.md`)).toEqual(originalBefore);
  });

  it("answers 400 and creates nothing when the tree has more than 500 pages", async () => {
    const project = await titledHost("Large project");
    const root = await subpage(project, "Large page");
    // 500 nested pages: 500 text blocks of the root, converted into subpages 200 at a time (the most one call takes).
    const blockIds = await insertMarkdown(
      root.pageItemId,
      Array.from({ length: 500 }, (_, index) => `Page ${index + 1}`).join("\n\n"),
    );
    expect(blockIds).toHaveLength(500);
    for (let start = 0; start < blockIds.length; start += 200) {
      const converted = await request("POST", `/api/items/${root.pageItemId}/page/subpages`, {
        body: { fromBlockIds: blockIds.slice(start, start + 200) },
      });
      expect(converted.status, converted.text).toBe(201);
    }
    expect((await pageOf(root.pageItemId)).subpageCount).toBe(500);
    const before = await stored();
    const parentBefore = await request("GET", `/api/items/${project}/page`);

    const answer = await duplicate(root.pageItemId);

    expect(answer.status, answer.text).toBe(400);
    expect(errorBody.parse(JSON.parse(answer.text)).error).toMatchObject({
      code: "validation_failed",
      details: { field: "pageItemId", reason: "too_many_pages" },
    });
    expect(await stored()).toEqual(before);
    expect(await request("GET", `/api/items/${project}/page`)).toEqual(parentBefore);
  }, 120_000);

  it("leaves out the block of a nested page that is in the trash", async () => {
    const project = await titledHost("Release project");
    const checklist = await subpage(project, "Release checklist");
    const kept = await subpage(checklist.pageItemId, "Kept");
    const trashed = await subpage(checklist.pageItemId, "In the trash");
    expect((await request("DELETE", `/api/items/${trashed.pageItemId}`)).status).toBe(200);

    const answer = await duplicate(checklist.pageItemId);

    expect(answer.status, answer.text).toBe(201);
    const copied = await pageOf(copyBody.parse(JSON.parse(answer.text)).pageItemId);
    expect(copied.blocks).toMatchObject([{ type: "page", text: "Kept" }]);
    expect(copied.subpageCount).toBe(1);
    expect(copied.blocks[0]?.pageId).not.toBe(kept.pageItemId);
    // The original still names both of its pages.
    expect((await pageOf(checklist.pageItemId)).blocks.map((block) => block.pageId)).toEqual([
      kept.pageItemId,
      trashed.pageItemId,
    ]);
  });

  it("answers 400 naming pageItemId for a host item, and 400 naming the path parameter for a malformed id", async () => {
    const project = await titledHost("Release project");
    await subpage(project, "Release checklist");
    const before = await stored();

    const host = await duplicate(project);
    const malformed = await duplicate("not-an-id");

    expect(host.status, host.text).toBe(400);
    expect(errorBody.parse(JSON.parse(host.text)).error).toMatchObject({
      code: "validation_failed",
      details: { field: "pageItemId" },
    });
    expect(malformed.status, malformed.text).toBe(400);
    expect(errorBody.parse(JSON.parse(malformed.text)).error).toMatchObject({
      code: "validation_failed",
      details: { field: "id" },
    });
    expect(await stored()).toEqual(before);
  });

  it("answers another tenant's page exactly like an unknown id, with 404, and the owner can duplicate it", async () => {
    const project = await titledHost("Mine");
    const page = await subpage(project, "Private page");
    const before = await stored();
    const parentBefore = await request("GET", `/api/items/${project}/page`);
    const unknown = randomUUID();

    const foreign = await duplicate(page.pageItemId, harness.headersB);
    const missing = await duplicate(unknown, harness.headersB);

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.text.replaceAll(page.pageItemId, "<id>")).toBe(missing.text.replaceAll(unknown, "<id>"));
    expect(errorBody.parse(JSON.parse(foreign.text)).error.code).toBe("not_found");
    expect(await stored()).toEqual(before);
    expect(await request("GET", `/api/items/${project}/page`)).toEqual(parentBefore);

    const own = await duplicate(page.pageItemId);
    expect(own.status, own.text).toBe(201);
    expect((await stored()).pagesItems).toBe(before.pagesItems + 1);
  });
});
