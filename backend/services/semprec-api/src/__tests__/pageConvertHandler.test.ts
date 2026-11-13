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
const pageBody = z.object({
  blocks: z.array(z.object({ id: z.string(), type: z.string(), text: z.string(), indent: z.number() })),
});
const convertedBody = z.object({ blockId: z.string(), trashedPageCount: z.number() }).strict();
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

/** A plain host item in tenant A. */
async function host(): Promise<string> {
  return runInTenant(harness.tenantA, async () => {
    const chokePoint = createChokePoint(harness.runtime);
    const database = await chokePoint.createDatabase({ name: `Hosts ${randomUUID()}` });
    return (await chokePoint.createItem({ databaseId: database.id, properties: {} })).id;
  });
}

async function subpage(parent: string, title: string): Promise<{ pageItemId: string; blockId: string }> {
  const created = await request("POST", `/api/items/${parent}/page/subpages`, { body: { title } });
  expect(created.status, created.text).toBe(201);
  const page = createdBody.parse(JSON.parse(created.text)).pages[0];
  if (!page) throw new Error("Missing page");
  return page;
}

function convert(parentItemId: string, body: unknown, headers?: Record<string, string>): Promise<Answer> {
  return request("POST", `/api/items/${parentItemId}/page/convert`, { body, headers });
}

async function blocksOf(itemId: string): Promise<z.infer<typeof pageBody>["blocks"]> {
  const read = await request("GET", `/api/items/${itemId}/page`);
  expect(read.status, read.text).toBe(200);
  return pageBody.parse(JSON.parse(read.text)).blocks;
}

/** Whether `GET /api/items/:id` still finds the item: a trashed item is answered as an unknown one. */
async function isLive(itemId: string): Promise<boolean> {
  return (await request("GET", `/api/items/${itemId}`)).status === 200;
}

/** What a refused conversion must leave as it found it: the parent's blocks, the pages' liveness and the update count. */
async function written(parentItemId: string, pageItemIds: string[]): Promise<unknown> {
  const { rows } = await runInTenant(harness.tenantA, () =>
    harness.runtime.query<{ n: number }>(`SELECT count(*)::int AS n FROM doc_updates`),
  );
  return {
    blocks: await blocksOf(parentItemId),
    live: await Promise.all(pageItemIds.map((id) => isLive(id))),
    updates: rows[0]?.n,
  };
}

function errorOf(answer: Answer): z.infer<typeof errorBody>["error"] {
  return errorBody.parse(JSON.parse(answer.text)).error;
}

describe("POST /api/items/:id/page/convert (issue #1876)", () => {
  beforeAll(() => harness.start());
  beforeEach(() => harness.reset());
  afterAll(() => harness.stop());

  it("trashes the page and its nested page and answers the new block with the count of trashed pages", async () => {
    const parent = await host();
    const checklist = await subpage(parent, "Release checklist");
    const notes = await subpage(checklist.pageItemId, "Notes");

    const answer = await convert(parent, { blockId: checklist.blockId, type: "h1", confirmedPageCount: 2 });

    expect(answer.status, answer.text).toBe(200);
    const converted = convertedBody.parse(JSON.parse(answer.text));
    expect(converted.trashedPageCount).toBe(2);
    // The page block was the only block of the parent's page; the trash left the empty text block an emptied document
    // keeps, and the new block stands where the page block stood, before it.
    expect(await blocksOf(parent)).toEqual([
      { id: converted.blockId, type: "h1", text: "Release checklist", indent: 0 },
      { id: expect.any(String), type: "text", text: "", indent: 0 },
    ]);
    expect(await isLive(checklist.pageItemId)).toBe(false);
    expect(await isLive(notes.pageItemId)).toBe(false);
  });

  it("answers 409 with the current count and changes nothing when the confirmed count is stale", async () => {
    const parent = await host();
    const checklist = await subpage(parent, "Release checklist");
    const notes = await subpage(checklist.pageItemId, "Notes");
    const before = await written(parent, [checklist.pageItemId, notes.pageItemId]);

    const answer = await convert(parent, { blockId: checklist.blockId, type: "text", confirmedPageCount: 1 });

    expect(answer.status, answer.text).toBe(409);
    expect(errorOf(answer).details).toMatchObject({ reason: "page_count_mismatch", currentPageCount: 2 });
    expect(await written(parent, [checklist.pageItemId, notes.pageItemId])).toEqual(before);
  });

  it("answers 400 naming the field for the page type, an unknown type and a block that is not a page block, and changes nothing", async () => {
    const parent = await host();
    const checklist = await subpage(parent, "Release checklist");
    const text = await runInTenant(harness.tenantA, async () => {
      const created = await request("POST", `/api/items/${parent}/page/insert`, {
        body: { placement: "end", markdown: "Plain text" },
      });
      expect(created.status, created.text).toBe(200);
      return z.object({ blockIds: z.array(z.string()).length(1) }).parse(JSON.parse(created.text)).blockIds[0] ?? "";
    });
    const before = await written(parent, [checklist.pageItemId]);
    const valid = { blockId: checklist.blockId, type: "text", confirmedPageCount: 1 };

    const cases: Array<[string, Answer, string]> = [
      ["the page type", await convert(parent, { ...valid, type: "page" }), "type"],
      ["an unknown type", await convert(parent, { ...valid, type: "heading" }), "type"],
      ["a block that is not a page block", await convert(parent, { ...valid, blockId: text }), "blockId"],
      ["an unknown block", await convert(parent, { ...valid, blockId: randomUUID() }), "blockId"],
    ];

    for (const [label, answer, field] of cases) {
      expect(answer.status, `${label}: ${answer.text}`).toBe(400);
      const error = errorOf(answer);
      expect(error.code, label).toBe("validation_failed");
      expect(error.details?.field, label).toBe(field);
    }
    expect(await written(parent, [checklist.pageItemId])).toEqual(before);
  });

  it("answers 400 for a body that is not exactly { blockId, type, confirmedPageCount }, naming the field, and changes nothing", async () => {
    const parent = await host();
    const checklist = await subpage(parent, "Release checklist");
    const before = await written(parent, [checklist.pageItemId]);
    const path = `/api/items/${parent}/page/convert`;
    const valid = { blockId: checklist.blockId, type: "text", confirmedPageCount: 1 };

    const cases: Array<[string, Answer, string | undefined]> = [
      ["no body", await request("POST", path), "blockId"],
      ["an array", await request("POST", path, { body: [valid] }), undefined],
      ["a missing block id", await request("POST", path, { body: { type: "text", confirmedPageCount: 1 } }), "blockId"],
      ["a missing type", await request("POST", path, { body: { ...valid, type: undefined } }), "type"],
      [
        "a missing count",
        await request("POST", path, { body: { ...valid, confirmedPageCount: undefined } }),
        "confirmedPageCount",
      ],
      ["a count of zero", await convert(parent, { ...valid, confirmedPageCount: 0 }), "confirmedPageCount"],
      ["a fractional count", await convert(parent, { ...valid, confirmedPageCount: 1.5 }), "confirmedPageCount"],
      ["a count that is a string", await convert(parent, { ...valid, confirmedPageCount: "1" }), "confirmedPageCount"],
      ["an extra field", await convert(parent, { ...valid, origin: "user" }), "origin"],
      ["a parent in the body", await convert(parent, { ...valid, parentItemId: randomUUID() }), "parentItemId"],
    ];

    for (const [label, answer, field] of cases) {
      expect(answer.status, `${label}: ${answer.text}`).toBe(400);
      const error = errorOf(answer);
      expect(error.code, label).toBe("validation_failed");
      expect(error.details?.field, label).toBe(field);
    }
    const malformedId = await convert("not-an-id", valid);
    expect(malformedId.status, malformedId.text).toBe(400);
    expect(errorOf(malformedId).details).toMatchObject({ field: "id" });
    expect(await written(parent, [checklist.pageItemId])).toEqual(before);
  });

  it("answers an unknown parent with 404", async () => {
    const answer = await convert(randomUUID(), { blockId: randomUUID(), type: "text", confirmedPageCount: 1 });

    expect(answer.status, answer.text).toBe(404);
    expect(errorOf(answer).code).toBe("not_found");
  });

  it("answers 401 without a session, and does not answer a GET", async () => {
    const parent = await host();
    const checklist = await subpage(parent, "Release checklist");
    const before = await written(parent, [checklist.pageItemId]);

    const anonymous = await request("POST", `/api/items/${parent}/page/convert`, {
      headers: {},
      body: { blockId: checklist.blockId, type: "text", confirmedPageCount: 1 },
    });
    const read = await request("GET", `/api/items/${parent}/page/convert`);

    expect(anonymous.status, anonymous.text).toBe(401);
    expect(read.status, read.text).toBeGreaterThanOrEqual(400);
    expect(await written(parent, [checklist.pageItemId])).toEqual(before);
  });

  it("answers another tenant's parent exactly like an unknown id, with 404, and the owner can convert", async () => {
    const parent = await host();
    const page = await subpage(parent, "Private page");
    const before = await written(parent, [page.pageItemId]);
    const unknown = randomUUID();
    const body = { blockId: page.blockId, type: "text", confirmedPageCount: 1 };

    const foreign = await convert(parent, body, harness.headersB);
    const missing = await convert(unknown, body, harness.headersB);

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.text.replaceAll(parent, "<id>")).toBe(missing.text.replaceAll(unknown, "<id>"));
    expect(errorOf(foreign).code).toBe("not_found");
    expect(await written(parent, [page.pageItemId])).toEqual(before);

    const own = await convert(parent, body);
    expect(own.status, own.text).toBe(200);
  });
});
