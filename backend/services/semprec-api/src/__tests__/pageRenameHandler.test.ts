import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import * as Y from "yjs";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { createChokePoint, mutateYDoc } from "@semprec/data";
import { PageHttpHarness } from "./pageHttpHarness.js";

const harness = new PageHttpHarness();

const createdBody = z.object({
  pages: z.array(z.object({ pageItemId: z.string(), docId: z.string(), blockId: z.string() })).length(1),
});
const pageBody = z.object({
  blocks: z.array(z.object({ id: z.string(), type: z.string(), text: z.string(), pageId: z.string().optional() })),
  breadcrumbs: z.array(z.object({ itemId: z.string(), title: z.string() })).nullable(),
});
const itemBody = z.object({ updatedAt: z.string(), properties: z.record(z.string(), z.unknown()) });
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
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const response = await fetch(`${harness.baseUrl}${path}`, {
    method,
    headers: {
      ...(options.headers ?? harness.headersA),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body,
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

async function subpage(parent: string, title: string): Promise<{ pageItemId: string; docId: string; blockId: string }> {
  const created = await request("POST", `/api/items/${parent}/page/subpages`, { body: { title } });
  expect(created.status, created.text).toBe(201);
  const page = createdBody.parse(JSON.parse(created.text)).pages[0];
  if (!page) throw new Error("Missing page");
  return page;
}

function rename(pageItemId: string, body: unknown, headers?: Record<string, string>): Promise<Answer> {
  return request("PATCH", `/api/items/${pageItemId}/page/title`, { body, headers });
}

async function pageOf(itemId: string): Promise<z.infer<typeof pageBody>> {
  const read = await request("GET", `/api/items/${itemId}/page`);
  expect(read.status, read.text).toBe(200);
  return pageBody.parse(JSON.parse(read.text));
}

async function itemOf(itemId: string): Promise<z.infer<typeof itemBody>> {
  const read = await request("GET", `/api/items/${itemId}`);
  expect(read.status, read.text).toBe(200);
  return itemBody.parse(JSON.parse(read.text));
}

/** The number of stored document updates of tenant A: a rename that writes a block adds exactly one. */
async function documentUpdates(): Promise<number> {
  const { rows } = await runInTenant(harness.tenantA, () =>
    harness.runtime.query<{ n: number }>(`SELECT count(*)::int AS n FROM doc_updates`),
  );
  return rows[0]?.n ?? -1;
}

/** What a refused or repeated rename must leave as it found it: the item, the parent's page and the update count. */
async function written(pageItemId: string, parentItemId: string): Promise<unknown> {
  return {
    item: await itemOf(pageItemId),
    parent: (await pageOf(parentItemId)).blocks,
    updates: await documentUpdates(),
  };
}

describe("PATCH /api/items/:id/page/title (issue #1725)", () => {
  beforeAll(() => harness.start());
  beforeEach(() => harness.reset());
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => harness.stop());

  it("shows the new title in the parent's block, on the item and in breadcrumbs composed without the parent's document", async () => {
    const notes = await titledHost("Notes");
    const checklist = await subpage(notes, "Checklist");
    const steps = await subpage(checklist.pageItemId, "Steps");
    const notesDocId = await harness.docIdOf(harness.tenantA, notes);
    const updatesBefore = await documentUpdates();

    const answer = await rename(checklist.pageItemId, { title: "Release checklist" });

    expect(answer.status, answer.text).toBe(200);
    expect(JSON.parse(answer.text)).toEqual({ pageItemId: checklist.pageItemId, title: "Release checklist" });
    expect((await pageOf(notes)).blocks).toEqual([
      { id: checklist.blockId, type: "page", text: "Release checklist", pageId: checklist.pageItemId },
    ]);
    expect((await itemOf(checklist.pageItemId)).properties).toMatchObject({
      title: "Release checklist",
      parentItemId: notes,
    });
    expect(await documentUpdates()).toBe(updatesBefore + 1);

    // From here on every statement that reads a document table is recorded, with its parameters.
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

    const ownTrail = (await pageOf(checklist.pageItemId)).breadcrumbs;
    const ownStatements = statements.splice(0);
    const nestedTrail = (await pageOf(steps.pageItemId)).breadcrumbs;
    const nestedStatements = statements.splice(0);

    expect(ownTrail?.map((crumb) => [crumb.itemId, crumb.title])).toEqual([
      [notes, "Notes"],
      [checklist.pageItemId, "Release checklist"],
    ]);
    expect(nestedTrail?.map((crumb) => crumb.title)).toEqual(["Notes", "Release checklist", "Steps"]);
    // Each read loaded the document of the page it was asked for, and no statement names a document or an item above it.
    expect(ownStatements.length).toBeGreaterThan(0);
    expect(nestedStatements.length).toBeGreaterThan(0);
    for (const statement of ownStatements) {
      for (const ancestor of [notes, notesDocId]) expect(statement).not.toContain(ancestor);
    }
    for (const statement of nestedStatements) {
      for (const ancestor of [notes, notesDocId, checklist.pageItemId, checklist.docId])
        expect(statement).not.toContain(ancestor);
    }
  });

  it("writes nothing when the same title is sent again", async () => {
    const notes = await titledHost("Notes");
    const checklist = await subpage(notes, "Checklist");
    expect((await rename(checklist.pageItemId, { title: "Release checklist" })).status).toBe(200);
    const afterFirst = await written(checklist.pageItemId, notes);

    const again = await rename(checklist.pageItemId, { title: "Release checklist" });

    expect(again.status, again.text).toBe(200);
    expect(JSON.parse(again.text)).toEqual({ pageItemId: checklist.pageItemId, title: "Release checklist" });
    expect(await written(checklist.pageItemId, notes)).toEqual(afterFirst);
  });

  it("changes the item's title and succeeds when the parent's document has no block for the page", async () => {
    const notes = await titledHost("Notes");
    const kept = await subpage(notes, "Kept");
    const checklist = await subpage(notes, "Checklist");
    const notesDocId = await harness.docIdOf(harness.tenantA, notes);
    // The block is removed the way an editor removes it over the sync socket, which leaves the page an orphan.
    await runInTenant(harness.tenantA, () =>
      mutateYDoc(harness.runtime, notesDocId, "user", (ydoc) => {
        const order = ydoc.getArray<string>("order");
        order.delete(order.toArray().indexOf(checklist.blockId), 1);
        ydoc.getMap<Y.Map<unknown>>("blocks").delete(checklist.blockId);
      }),
    );
    const parentBefore = (await pageOf(notes)).blocks;
    expect(parentBefore.map((block) => block.id)).toEqual([kept.blockId]);
    const updatesBefore = await documentUpdates();

    const answer = await rename(checklist.pageItemId, { title: "Release checklist" });

    expect(answer.status, answer.text).toBe(200);
    expect(JSON.parse(answer.text)).toEqual({ pageItemId: checklist.pageItemId, title: "Release checklist" });
    expect((await itemOf(checklist.pageItemId)).properties.title).toBe("Release checklist");
    expect((await pageOf(notes)).blocks).toEqual(parentBefore);
    expect(await documentUpdates()).toBe(updatesBefore);
  });

  it("answers 400 naming title for a title over 500 characters and changes nothing, and accepts 500", async () => {
    const notes = await titledHost("Notes");
    const checklist = await subpage(notes, "Checklist");
    const before = await written(checklist.pageItemId, notes);

    const refused = await rename(checklist.pageItemId, { title: "x".repeat(501) });

    expect(refused.status, refused.text).toBe(400);
    expect(errorBody.parse(JSON.parse(refused.text)).error).toMatchObject({
      code: "validation_failed",
      details: { field: "title" },
    });
    expect(await written(checklist.pageItemId, notes)).toEqual(before);

    const accepted = await rename(checklist.pageItemId, { title: "x".repeat(500) });
    expect(accepted.status, accepted.text).toBe(200);
    expect((await itemOf(checklist.pageItemId)).properties.title).toBe("x".repeat(500));
  });

  it("answers 400 for a body that is not exactly { title: string }, naming the field, and changes nothing", async () => {
    const notes = await titledHost("Notes");
    const checklist = await subpage(notes, "Checklist");
    const before = await written(checklist.pageItemId, notes);
    const path = `/api/items/${checklist.pageItemId}/page/title`;

    const cases: Array<[string, Answer, string | undefined]> = [
      // The adapter reads an absent body as an empty object, so it is a missing title.
      ["no body", await request("PATCH", path), "title"],
      ["an array", await request("PATCH", path, { body: ["Release checklist"] }), undefined],
      ["a missing title", await request("PATCH", path, { body: {} }), "title"],
      ["a title that is not a string", await request("PATCH", path, { body: { title: 7 } }), "title"],
      ["an extra field", await request("PATCH", path, { body: { title: "Renamed", origin: "user" } }), "origin"],
      [
        "a page id in the body",
        await request("PATCH", path, { body: { title: "Renamed", pageItemId: randomUUID() } }),
        "pageItemId",
      ],
    ];

    for (const [label, answer, field] of cases) {
      expect(answer.status, `${label}: ${answer.text}`).toBe(400);
      const error = errorBody.parse(JSON.parse(answer.text)).error;
      expect(error.code, label).toBe("validation_failed");
      expect(error.details?.field, label).toBe(field);
    }
    const malformedId = await rename("not-an-id", { title: "Renamed" });
    expect(malformedId.status, malformedId.text).toBe(400);
    expect(errorBody.parse(JSON.parse(malformedId.text)).error.details).toMatchObject({ field: "id" });
    expect(await written(checklist.pageItemId, notes)).toEqual(before);
  });

  it("answers 400 naming pageItemId for a host item", async () => {
    const notes = await titledHost("Notes");
    const checklist = await subpage(notes, "Checklist");
    const before = await written(checklist.pageItemId, notes);

    const answer = await rename(notes, { title: "Renamed host" });

    expect(answer.status, answer.text).toBe(400);
    expect(errorBody.parse(JSON.parse(answer.text)).error).toMatchObject({
      code: "validation_failed",
      details: { field: "pageItemId" },
    });
    expect(await written(checklist.pageItemId, notes)).toEqual(before);
    expect((await itemOf(notes)).properties.name).toBe("Notes");
  });

  it("answers another tenant's page exactly like an unknown id, with 404, and the owner can rename it", async () => {
    const notes = await titledHost("Mine");
    const page = await subpage(notes, "Private page");
    const before = await written(page.pageItemId, notes);
    const unknown = randomUUID();

    const foreign = await rename(page.pageItemId, { title: "Taken over" }, harness.headersB);
    const missing = await rename(unknown, { title: "Taken over" }, harness.headersB);

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.text.replaceAll(page.pageItemId, "<id>")).toBe(missing.text.replaceAll(unknown, "<id>"));
    expect(errorBody.parse(JSON.parse(foreign.text)).error.code).toBe("not_found");
    expect(await written(page.pageItemId, notes)).toEqual(before);

    const own = await rename(page.pageItemId, { title: "Still mine" });
    expect(own.status, own.text).toBe(200);
    expect((await itemOf(page.pageItemId)).properties.title).toBe("Still mine");
  });
});
