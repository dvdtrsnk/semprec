import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { PageHttpHarness } from "./pageHttpHarness.js";

const harness = new PageHttpHarness();

const FILLER_ETAG = "A".repeat(43);

const replacedBody = z
  .object({ trashedPages: z.array(z.object({ pageItemId: z.string(), title: z.string() }).strict()) })
  .strict();
const errorBody = z.object({ error: z.object({ code: z.string(), details: z.unknown().optional() }) });
const insertedBody = z.object({ blockIds: z.array(z.string()) });
const createdBody = z.object({
  pages: z.array(z.object({ pageItemId: z.string(), blockId: z.string() })).length(1),
});
const summaryBody = z.object({
  blocks: z.array(z.object({ id: z.string(), type: z.string(), text: z.string(), pageId: z.string().optional() })),
});
const itemBody = z.object({ properties: z.record(z.string(), z.unknown()) });

type Headers = Record<string, string>;

interface Answer {
  status: number;
  text: string;
  headers: Response["headers"];
}

/** `PUT /api/items/:id/page.md` with the headers a client sends; `etag` undefined sends no `If-Match`. */
async function put(
  headers: Headers | undefined,
  itemId: string,
  markdown: string | Uint8Array,
  options: { etag?: string | undefined; ifMatch?: string; contentType?: string } = {},
): Promise<Answer> {
  const ifMatch = options.ifMatch ?? (options.etag === undefined ? undefined : `"${options.etag}"`);
  const response = await fetch(`${harness.baseUrl}/api/items/${itemId}/page.md`, {
    method: "PUT",
    headers: {
      ...headers,
      "Content-Type": options.contentType ?? "text/markdown; charset=utf-8",
      ...(ifMatch === undefined ? {} : { "If-Match": ifMatch }),
    },
    body: markdown,
  });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

/** The Markdown of the page and its token, as `GET /api/items/:id/page.md` answers. */
async function read(itemId: string, headers: Headers = harness.headersA): Promise<{ markdown: string; etag: string }> {
  const response = await fetch(`${harness.baseUrl}/api/items/${itemId}/page.md`, { headers });
  expect(response.status).toBe(200);
  const etag = response.headers.get("etag")?.replaceAll('"', "") ?? "";
  expect(etag).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return { markdown: await response.text(), etag };
}

/** Replaces the page with the token it has now; returns the answer. */
async function replace(itemId: string, markdown: string, headers: Headers = harness.headersA): Promise<Answer> {
  return put(headers, itemId, markdown, { etag: (await read(itemId, headers)).etag });
}

async function insertMarkdown(itemId: string, markdown: string): Promise<string[]> {
  const response = await fetch(`${harness.baseUrl}/api/items/${itemId}/page/insert`, {
    method: "POST",
    headers: { ...harness.headersA, "Content-Type": "application/json" },
    body: JSON.stringify({ placement: "end", markdown }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return insertedBody.parse(await response.json()).blockIds;
}

interface Subpage {
  pageItemId: string;
  blockId: string;
}

async function createSubpage(parent: string, title: string, afterBlockId?: string): Promise<Subpage> {
  const response = await fetch(`${harness.baseUrl}/api/items/${parent}/page/subpages`, {
    method: "POST",
    headers: { ...harness.headersA, "Content-Type": "application/json" },
    body: JSON.stringify({ title, afterBlockId }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const page = createdBody.parse(await response.json()).pages[0];
  if (!page) throw new Error("Missing page");
  return page;
}

/** The blocks of the page of `itemId` in document order. */
async function blocksOf(itemId: string): Promise<z.infer<typeof summaryBody>["blocks"]> {
  const response = await fetch(`${harness.baseUrl}/api/items/${itemId}/page`, { headers: harness.headersA });
  expect(response.status).toBe(200);
  return summaryBody.parse(await response.json()).blocks;
}

/** The status of `GET /api/items/:id` for each id, as tenant A. */
async function statusesOf(...itemIds: string[]): Promise<number[]> {
  const statuses: number[] = [];
  for (const id of itemIds) {
    statuses.push((await fetch(`${harness.baseUrl}/api/items/${id}`, { headers: harness.headersA })).status);
  }
  return statuses;
}

async function titleOf(itemId: string): Promise<unknown> {
  const response = await fetch(`${harness.baseUrl}/api/items/${itemId}`, { headers: harness.headersA });
  expect(response.status).toBe(200);
  return itemBody.parse(await response.json()).properties.title;
}

interface PageState {
  docs: number;
  updates: number;
  relations: number;
}

/** What a refused replace must leave exactly as it found it: documents, stored updates and relation edges of the tenant. */
async function stateOf(): Promise<PageState> {
  const { rows } = await runInTenant(harness.tenantA, () =>
    harness.runtime.query<PageState>(
      `SELECT (SELECT count(*)::int FROM docs) AS docs,
              (SELECT count(*)::int FROM doc_updates) AS updates,
              (SELECT count(*)::int FROM item_relations) AS relations`,
    ),
  );
  const row = rows[0];
  if (!row) throw new Error("Missing page state");
  return row;
}

async function lastUpdateAuthor(itemId: string): Promise<string | undefined> {
  const { rows } = await runInTenant(harness.tenantA, () =>
    harness.runtime.query<{ created_by: string }>(
      `SELECT u.created_by FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.item_id = $1 ORDER BY u.id DESC LIMIT 1`,
      [itemId],
    ),
  );
  return rows[0]?.created_by;
}

function parseError(answer: Answer): z.infer<typeof errorBody>["error"] {
  return errorBody.parse(JSON.parse(answer.text)).error;
}

/** A host of tenant A whose notes read `Intro`, a page block for "Release checklist", `Outro`. */
async function hostWithSubpage(): Promise<{ host: string; intro: string; outro: string; checklist: Subpage }> {
  const host = await harness.createHost(harness.tenantA);
  const [intro, outro] = await insertMarkdown(host, "Intro\n\nOutro");
  if (!intro || !outro) throw new Error("Missing inserted blocks");
  const checklist = await createSubpage(host, "Release checklist", intro);
  return { host, intro, outro, checklist };
}

describe("PUT /api/items/:id/page.md (issue #1765)", () => {
  beforeAll(() => harness.start());
  beforeEach(() => harness.reset());
  afterAll(() => harness.stop());

  describe("replacing the body", () => {
    it("keeps the id of every block it does not change when one paragraph changes, and answers the new ETag", async () => {
      const host = await harness.createHost(harness.tenantA);
      await insertMarkdown(host, "# Plan\n\nFirst paragraph\n\nSecond paragraph\n\n- a bullet");
      const before = await blocksOf(host);

      const answer = await replace(host, "# Plan\n\nFirst paragraph\n\nSecond paragraph, reworded\n\n- a bullet");

      expect(answer.status, answer.text).toBe(200);
      expect(replacedBody.parse(JSON.parse(answer.text))).toEqual({ trashedPages: [] });
      const after = await blocksOf(host);
      expect(after.map((block) => block.text)).toEqual([
        "Plan",
        "First paragraph",
        "Second paragraph, reworded",
        "a bullet",
      ]);
      expect(after.map((block, index) => (index === 2 ? null : block.id))).toEqual(
        before.map((block, index) => (index === 2 ? null : block.id)),
      );
      expect(after[2]?.id).not.toBe(before[2]?.id);
      const current = await read(host);
      expect(answer.headers.get("etag")).toBe(`"${current.etag}"`);
      expect(answer.headers.get("cache-control")).toBe("no-store");
      expect(await lastUpdateAuthor(host)).toBe("user");
    });

    it("writes nothing and answers the same ETag when the Markdown is the page as it stands", async () => {
      const host = await harness.createHost(harness.tenantA);
      await insertMarkdown(host, "One\n\nTwo");
      const { markdown, etag } = await read(host);
      const before = await stateOf();

      const answer = await put(harness.headersA, host, markdown, { etag });

      expect(answer.status).toBe(200);
      expect(answer.headers.get("etag")).toBe(`"${etag}"`);
      expect(await stateOf()).toEqual(before);
    });

    it("empties a page to the one empty block an emptied page keeps, and a second empty replace writes nothing", async () => {
      const host = await harness.createHost(harness.tenantA);
      await insertMarkdown(host, "One\n\nTwo");

      const emptied = await replace(host, "");
      expect(emptied.status, emptied.text).toBe(200);
      const blocks = await blocksOf(host);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({ type: "text", text: "" });
      const before = await stateOf();

      const again = await replace(host, "");
      expect(again.status).toBe(200);
      expect(await stateOf()).toEqual(before);
    });

    it("creates the page of an item without one from the token of an empty document", async () => {
      const host = await harness.createHost(harness.tenantA);
      expect((await stateOf()).docs).toBe(0);
      const { markdown, etag } = await read(host);
      expect(markdown).toBe("");

      const answer = await put(harness.headersA, host, "# Created\n\nBody", { etag });

      expect(answer.status, answer.text).toBe(200);
      expect((await stateOf()).docs).toBe(1);
      expect((await blocksOf(host)).map((block) => block.text)).toEqual(["Created", "Body"]);
    });

    it("creates no document for empty Markdown on an item without one", async () => {
      const host = await harness.createHost(harness.tenantA);
      const { etag } = await read(host);
      const before = await stateOf();

      const answer = await put(harness.headersA, host, "", { etag });

      expect(answer.status).toBe(200);
      expect(answer.headers.get("etag")).toBe(`"${etag}"`);
      expect(await stateOf()).toEqual(before);
    });

    it("ends with one success and one 409 when two requests race with the same ETag", async () => {
      const host = await harness.createHost(harness.tenantA);
      await insertMarkdown(host, "Start");
      const { etag } = await read(host);

      const answers = await Promise.all([
        put(harness.headersA, host, "Winner one", { etag }),
        put(harness.headersA, host, "Winner two", { etag }),
      ]);

      expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
      const winner = answers.find((answer) => answer.status === 200);
      const loser = answers.find((answer) => answer.status === 409);
      const current = await read(host);
      expect(winner?.headers.get("etag")).toBe(`"${current.etag}"`);
      expect(loser?.headers.get("etag")).toBe(`"${current.etag}"`);
      expect(["Winner one", "Winner two"]).toContain(current.markdown);
    });
  });

  describe("the If-Match precondition", () => {
    it("answers 428 without If-Match and writes nothing", async () => {
      const host = await harness.createHost(harness.tenantA);
      await insertMarkdown(host, "Unchanged");
      const before = { state: await stateOf(), page: await read(host) };

      const answer = await put(harness.headersA, host, "Overwritten", { etag: undefined });

      expect(answer.status).toBe(428);
      expect(parseError(answer).code).toBe("precondition_required");
      expect({ state: await stateOf(), page: await read(host) }).toEqual(before);
    });

    it("answers 409 with the current ETag for a stale token and leaves the document unchanged", async () => {
      const host = await harness.createHost(harness.tenantA);
      await insertMarkdown(host, "First version");
      const stale = (await read(host)).etag;
      await insertMarkdown(host, "A concurrent edit");
      const before = { state: await stateOf(), page: await read(host) };

      const answer = await put(harness.headersA, host, "Overwritten", { etag: stale });

      expect(answer.status).toBe(409);
      expect(parseError(answer).code).toBe("version_conflict");
      expect(answer.headers.get("etag")).toBe(`"${before.page.etag}"`);
      expect({ state: await stateOf(), page: await read(host) }).toEqual(before);
    });

    it("answers 400 for an If-Match that is not one quoted strong tag, before it reads the item", async () => {
      const host = await harness.createHost(harness.tenantA);
      const before = await stateOf();
      for (const ifMatch of [`W/"${FILLER_ETAG}"`, "*", FILLER_ETAG, `"${FILLER_ETAG}", "${FILLER_ETAG}"`, '""']) {
        const answer = await put(harness.headersA, host, "Text", { ifMatch });
        expect(answer.status, ifMatch).toBe(400);
        expect(parseError(answer).details).toEqual({ field: "If-Match" });
      }
      expect(await stateOf()).toEqual(before);
    });
  });

  describe("the request body", () => {
    it("answers 400 unless the body is text/markdown in UTF-8", async () => {
      const host = await harness.createHost(harness.tenantA);
      const { etag } = await read(host);
      const before = await stateOf();
      for (const contentType of ["application/json", "text/plain", "", "text/markdown; charset=iso-8859-1"]) {
        const answer = await put(harness.headersA, host, "Text", { etag, contentType });
        expect(answer.status, contentType).toBe(400);
        expect(parseError(answer).details).toEqual({ field: "Content-Type" });
      }
      expect(await stateOf()).toEqual(before);
    });

    it("accepts the media type without a charset and with a quoted UTF-8 charset", async () => {
      const host = await harness.createHost(harness.tenantA);
      for (const [index, contentType] of ["text/markdown", 'TEXT/Markdown; charset="UTF-8"'].entries()) {
        const answer = await put(harness.headersA, host, `Body ${index}`, {
          etag: (await read(host)).etag,
          contentType,
        });
        expect(answer.status, contentType).toBe(200);
      }
      expect((await read(host)).markdown).toBe("Body 1");
    });

    it("answers 400 for bytes that are not UTF-8 and writes nothing", async () => {
      const host = await harness.createHost(harness.tenantA);
      const { etag } = await read(host);
      const before = await stateOf();

      const answer = await put(harness.headersA, host, new Uint8Array([0x61, 0xff, 0xfe]), { etag });

      expect(answer.status).toBe(400);
      expect(parseError(answer).details).toEqual({ field: "body" });
      expect(await stateOf()).toEqual(before);
    });

    it("answers 413 for a body over the cap and writes nothing", async () => {
      const host = await harness.createHost(harness.tenantA);
      const { etag } = await read(host);
      const before = await stateOf();

      const answer = await put(harness.headersA, host, "a".repeat(1024 * 1024 + 1), { etag });

      expect(answer.status).toBe(413);
      expect(parseError(answer).code).toBe("payload_too_large");
      expect(await stateOf()).toEqual(before);
    });

    it("answers 400 for Markdown past the operation's length limit, which fits the byte cap", async () => {
      const host = await harness.createHost(harness.tenantA);
      const { etag } = await read(host);

      const answer = await put(harness.headersA, host, "a".repeat(1_000_001), { etag });

      expect(answer.status).toBe(400);
      expect(parseError(answer).code).toBe("validation_failed");
    });

    it("answers 400 for an invalid block, naming the field and block and not the Markdown, and creates no document", async () => {
      const host = await harness.createHost(harness.tenantA);
      const { etag } = await read(host);
      const before = await stateOf();

      const answer = await put(harness.headersA, host, "Fine\n\n<!-- semprec:block type=table -->\nSecret cell", {
        etag,
      });

      expect(answer.status).toBe(400);
      expect(parseError(answer).details).toMatchObject({ field: "markdown", path: expect.stringMatching(/^block 2/) });
      expect(answer.text).not.toContain("Secret cell");
      expect(await stateOf()).toEqual(before);
    });
  });

  describe("links to items", () => {
    it("accepts a live item of the tenant, and refuses unknown, foreign, trashed and malformed targets alike", async () => {
      const host = await harness.createHost(harness.tenantA);
      const live = await harness.createHost(harness.tenantA);
      const trashed = await harness.createHost(harness.tenantA);
      const foreign = await harness.createHost(harness.tenantB);
      expect(
        (await fetch(`${harness.baseUrl}/api/items/${trashed}`, { method: "DELETE", headers: harness.headersA }))
          .status,
      ).toBe(200);
      const link = (target: string) => `See [the item](semprec://items/${target})`;

      const refusals = new Map<string, Answer>();
      for (const [name, target] of [
        ["unknown", randomUUID()],
        ["foreign", foreign],
        ["trashed", trashed],
        ["malformed", "not-a-uuid"],
      ] as const) {
        const before = await stateOf();
        refusals.set(name, await put(harness.headersA, host, link(target), { etag: (await read(host)).etag }));
        expect(await stateOf(), name).toEqual(before);
      }

      for (const [name, answer] of refusals) {
        expect(answer.status, name).toBe(400);
        expect(parseError(answer), name).toEqual({
          code: "validation_failed",
          details: { field: "markdown" },
        });
      }
      const bodies = new Set([...refusals.values()].map((answer) => answer.text));
      expect(bodies.size).toBe(1);

      const accepted = await put(harness.headersA, host, link(live), { etag: (await read(host)).etag });
      expect(accepted.status, accepted.text).toBe(200);
      expect((await read(host)).markdown).toBe(link(live));
    });
  });

  describe("links to subpages", () => {
    it("sends a subpage whose link line vanished to the trash in the same request, lists it, and restores its block in place", async () => {
      const { host, intro, outro, checklist } = await hostWithSubpage();
      expect((await blocksOf(host)).map((block) => block.id)).toEqual([intro, checklist.blockId, outro]);

      const answer = await replace(host, "Intro\n\nOutro");

      expect(answer.status, answer.text).toBe(200);
      expect(replacedBody.parse(JSON.parse(answer.text))).toEqual({
        trashedPages: [{ pageItemId: checklist.pageItemId, title: "Release checklist" }],
      });
      expect(await statusesOf(checklist.pageItemId, host)).toEqual([404, 200]);
      expect((await blocksOf(host)).map((block) => block.id)).toEqual([intro, outro]);

      // Undo: the restore of the trashed page puts its block back after the block that stood before it.
      const restored = await fetch(`${harness.baseUrl}/api/items/${checklist.pageItemId}/restore`, {
        method: "POST",
        headers: harness.headersA,
      });
      expect(restored.status).toBe(200);
      const afterUndo = await blocksOf(host);
      expect(afterUndo.map((block) => block.type)).toEqual(["text", "page", "text"]);
      expect(afterUndo[1]).toMatchObject({
        id: checklist.blockId,
        pageId: checklist.pageItemId,
        text: "Release checklist",
      });
      expect([afterUndo[0]?.id, afterUndo[2]?.id]).toEqual([intro, outro]);
    });

    it("commits a text change together with the trash of the subpage whose link vanished", async () => {
      const { host, outro, checklist } = await hostWithSubpage();

      const answer = await replace(host, "Intro, reworded\n\nOutro");

      expect(answer.status, answer.text).toBe(200);
      expect(replacedBody.parse(JSON.parse(answer.text)).trashedPages.map((page) => page.pageItemId)).toEqual([
        checklist.pageItemId,
      ]);
      expect(await statusesOf(checklist.pageItemId)).toEqual([404]);
      const blocks = await blocksOf(host);
      expect(blocks.map((block) => block.text)).toEqual(["Intro, reworded", "Outro"]);
      expect(blocks[1]?.id).toBe(outro);
    });

    it("restores the block after the reworded block when the same request rewrote the block before the dropped link", async () => {
      const { host, outro, checklist } = await hostWithSubpage();

      const answer = await replace(host, "Intro, reworded\n\nOutro");
      expect(answer.status, answer.text).toBe(200);
      const reworded = (await blocksOf(host)).map((block) => block.id);
      expect(reworded).toHaveLength(2);

      const restored = await fetch(`${harness.baseUrl}/api/items/${checklist.pageItemId}/restore`, {
        method: "POST",
        headers: harness.headersA,
      });
      expect(restored.status).toBe(200);
      const afterUndo = await blocksOf(host);
      expect(afterUndo.map((block) => block.type)).toEqual(["text", "page", "text"]);
      expect(afterUndo.map((block) => block.text)).toEqual(["Intro, reworded", "Release checklist", "Outro"]);
      expect(afterUndo[1]?.id).toBe(checklist.blockId);
      expect([afterUndo[0]?.id, afterUndo[2]?.id]).toEqual([reworded[0], outro]);
    });

    it("restores the block at the start when the same request removed every block before the dropped link", async () => {
      const { host, checklist } = await hostWithSubpage();

      const answer = await replace(host, "Outro");
      expect(answer.status, answer.text).toBe(200);
      const restored = await fetch(`${harness.baseUrl}/api/items/${checklist.pageItemId}/restore`, {
        method: "POST",
        headers: harness.headersA,
      });
      expect(restored.status).toBe(200);

      expect((await blocksOf(host)).map((block) => block.text)).toEqual(["Release checklist", "Outro"]);
    });

    it("takes the subpages nested in a removed link to the trash with it", async () => {
      const { host, checklist } = await hostWithSubpage();
      const nested = await createSubpage(checklist.pageItemId, "Notes for version 0.4");

      const answer = await replace(host, "Intro\n\nOutro");

      expect(answer.status, answer.text).toBe(200);
      expect(replacedBody.parse(JSON.parse(answer.text)).trashedPages.map((page) => page.pageItemId)).toEqual([
        checklist.pageItemId,
      ]);
      expect(await statusesOf(checklist.pageItemId, nested.pageItemId)).toEqual([404, 404]);
    });

    it("trashes only the pages whose links vanished and keeps a link that stays, with its block id", async () => {
      const { host, intro, checklist } = await hostWithSubpage();
      const second = await createSubpage(host, "Retro", checklist.blockId);
      const before = await read(host);
      expect(before.markdown).toContain("[Retro]");

      const answer = await put(
        harness.headersA,
        host,
        before.markdown.replace(/\n\n\[Release checklist\]\([^)]*\)/, ""),
        {
          etag: before.etag,
        },
      );

      expect(answer.status, answer.text).toBe(200);
      expect(replacedBody.parse(JSON.parse(answer.text)).trashedPages).toEqual([
        { pageItemId: checklist.pageItemId, title: "Release checklist" },
      ]);
      expect(await statusesOf(checklist.pageItemId, second.pageItemId)).toEqual([404, 200]);
      const blocks = await blocksOf(host);
      expect(blocks.map((block) => block.id)).toEqual([intro, second.blockId, blocks[2]?.id]);
    });

    it("refuses a link to an unknown id, to another parent's page, to a trashed subpage and to a host, and writes nothing", async () => {
      const { host, checklist } = await hostWithSubpage();
      const other = await harness.createHost(harness.tenantA);
      const foreignParent = await createSubpage(other, "Somebody else's page");
      const trashed = await createSubpage(host, "Soon trashed");
      expect(
        (
          await fetch(`${harness.baseUrl}/api/items/${trashed.pageItemId}`, {
            method: "DELETE",
            headers: harness.headersA,
          })
        ).status,
      ).toBe(200);
      const before = { state: await stateOf(), page: await read(host) };

      const bodies = new Set<string>();
      for (const target of [randomUUID(), foreignParent.pageItemId, trashed.pageItemId, other, "not-a-uuid"]) {
        const answer = await put(harness.headersA, host, `Intro\n\n[Look](semprec://page/${target})`, {
          etag: before.page.etag,
        });
        expect(answer.status, target).toBe(400);
        expect(parseError(answer).details).toEqual({
          field: "markdown",
          path: "block 2: pageId",
          reason: "page_link_invalid",
        });
        bodies.add(answer.text);
      }

      expect(bodies.size).toBe(1);
      expect({ state: await stateOf(), page: await read(host) }).toEqual(before);
      expect(await statusesOf(checklist.pageItemId, foreignParent.pageItemId)).toEqual([200, 200]);
    });

    it("renames the subpage when the text of its link changed, in the item and in the block", async () => {
      const { host, intro, outro, checklist } = await hostWithSubpage();

      const answer = await replace(
        host,
        `Intro\n\n[Launch checklist](semprec://page/${checklist.pageItemId})\n\nOutro`,
      );

      expect(answer.status, answer.text).toBe(200);
      expect(replacedBody.parse(JSON.parse(answer.text))).toEqual({ trashedPages: [] });
      expect(await titleOf(checklist.pageItemId)).toBe("Launch checklist");
      const blocks = await blocksOf(host);
      // The block was retitled in place, so it is the same block and no other block changed.
      expect(blocks.map((block) => block.id)).toEqual([intro, checklist.blockId, outro]);
      expect(blocks[1]?.text).toBe("Launch checklist");
    });

    it("refuses a link caption over the title limit with 400 and writes nothing", async () => {
      const { host, checklist } = await hostWithSubpage();
      const before = { state: await stateOf(), page: await read(host) };

      const answer = await put(
        harness.headersA,
        host,
        `Intro\n\n[${"x".repeat(501)}](semprec://page/${checklist.pageItemId})\n\nOutro`,
        { etag: before.page.etag },
      );

      expect(answer.status).toBe(400);
      expect(parseError(answer).details).toEqual({
        field: "markdown",
        path: "block 2: text",
        reason: "page_title_too_long",
      });
      expect({ state: await stateOf(), page: await read(host) }).toEqual(before);
      expect(await titleOf(checklist.pageItemId)).toBe("Release checklist");
    });

    it("reads a caption with escapes and a link line with leading blanks the way the read writes it", async () => {
      const { host, checklist } = await hostWithSubpage();
      const markdown = `Intro\n\n   [Plan \\[v2\\] *final*](semprec://page/${checklist.pageItemId})  \n\nOutro`;

      const answer = await replace(host, markdown);

      expect(answer.status, answer.text).toBe(200);
      expect(await titleOf(checklist.pageItemId)).toBe("Plan [v2] final");
    });
  });

  describe("who may replace", () => {
    it("answers an item of another tenant exactly like an unknown id, and a trashed item with 404", async () => {
      const hostA = await harness.createHost(harness.tenantA);
      await insertMarkdown(hostA, "Private");
      const before = { state: await stateOf(), page: await read(hostA) };
      const unknown = randomUUID();

      const foreign = await put(harness.headersB, hostA, "Intrusion", { etag: before.page.etag });
      const missing = await put(harness.headersB, unknown, "Intrusion", { etag: before.page.etag });

      expect(foreign.status).toBe(404);
      expect(foreign.text.replaceAll(hostA, "<id>")).toBe(missing.text.replaceAll(unknown, "<id>"));
      expect({ state: await stateOf(), page: await read(hostA) }).toEqual(before);

      const trashed = await harness.createHost(harness.tenantA);
      expect(
        (await fetch(`${harness.baseUrl}/api/items/${trashed}`, { method: "DELETE", headers: harness.headersA }))
          .status,
      ).toBe(200);
      expect((await put(harness.headersA, trashed, "Late", { etag: FILLER_ETAG })).status).toBe(404);
    });

    it("answers an item of another tenant like an unknown id even without If-Match, and 401 without a session", async () => {
      const hostA = await harness.createHost(harness.tenantA);
      const unknown = randomUUID();

      const foreign = await put(harness.headersB, hostA, "Intrusion", { etag: undefined });
      const missing = await put(harness.headersB, unknown, "Intrusion", { etag: undefined });

      expect(foreign.status).toBe(428);
      expect(foreign.text).toBe(missing.text);
      expect((await put(undefined, hostA, "Anonymous", { etag: FILLER_ETAG })).status).toBe(401);
    });

    it("holds a run credential's replace for approval with a 403 approval_required, writes nothing, and answers a credential without core.item.write like an unknown operation (issue #1844)", async () => {
      const host = await harness.createHost(harness.tenantA);
      await insertMarkdown(host, "Unchanged");
      const before = { state: await stateOf(), page: await read(host) };
      const token = await harness.mintRunCredential(harness.tenantA, ["core.item.write"]);

      const held = await put({ Authorization: `Bearer ${token}` }, host, "By the agent", { etag: before.page.etag });

      expect(held.status).toBe(403);
      expect(parseError(held).code).toBe("approval_required");
      expect({ state: await stateOf(), page: await read(host) }).toEqual(before);

      const withheld = await harness.mintRunCredential(harness.tenantA, ["core.item.read"]);
      const refused = await put({ Authorization: `Bearer ${withheld}` }, host, "By the agent", {
        etag: before.page.etag,
      });
      expect(refused.status).toBe(404);
      expect({ state: await stateOf(), page: await read(host) }).toEqual(before);
    });
  });
});
