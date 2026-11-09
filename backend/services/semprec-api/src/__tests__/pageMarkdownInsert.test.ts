import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { writePageTextBlocks } from "@semprec/data/testSupport";
import { loadYDoc } from "@semprec/data";
import { PageHttpHarness } from "./pageHttpHarness.js";

const harness = new PageHttpHarness();

const insertedBody = z.object({ blockIds: z.array(z.string()) }).strict();
const summaryBody = z.object({ blocks: z.array(z.object({ id: z.string(), type: z.string(), text: z.string() })) });
const errorBody = z.object({ error: z.object({ code: z.string(), details: z.unknown().optional() }) });

interface Inserted {
  status: number;
  text: string;
}

async function insert(
  headers: Record<string, string> | undefined,
  itemId: string,
  body: Record<string, unknown>,
): Promise<Inserted> {
  const response = await fetch(`${harness.baseUrl}/api/items/${itemId}/page/insert`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

function idsOf(inserted: Inserted): string[] {
  expect(inserted.status, inserted.text).toBe(200);
  return insertedBody.parse(JSON.parse(inserted.text)).blockIds;
}

async function blocksOf(itemId: string): Promise<Array<{ id: string; type: string; text: string }>> {
  const response = await fetch(`${harness.baseUrl}/api/items/${itemId}/page`, { headers: harness.headersA });
  return summaryBody.parse(await response.json()).blocks;
}

interface PageState {
  docs: number;
  updates: number;
  relations: number;
}

/** What a refused insert must leave exactly as it found it. */
async function stateOf(itemId: string): Promise<PageState> {
  const { rows } = await runInTenant(harness.tenantA, () =>
    harness.runtime.query<PageState>(
      `SELECT (SELECT count(*)::int FROM docs WHERE item_id = $1) AS docs,
              (SELECT count(*)::int FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.item_id = $1) AS updates,
              (SELECT count(*)::int FROM item_relations) AS relations`,
      [itemId],
    ),
  );
  const row = rows[0];
  if (!row) throw new Error("Missing page state");
  return row;
}

/** Trashes `itemId` of tenant A through the production route. */
async function trash(itemId: string): Promise<void> {
  const response = await fetch(`${harness.baseUrl}/api/items/${itemId}`, {
    method: "DELETE",
    headers: harness.headersA,
  });
  expect(response.status).toBe(200);
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

describe("POST /api/items/:id/page/insert (issue #1679)", () => {
  beforeAll(() => harness.start());
  beforeEach(() => harness.reset());
  afterAll(() => harness.stop());

  it("creates the document on the first insert, appends at the end and returns the ids in order", async () => {
    const host = await harness.createHost(harness.tenantA);
    expect((await stateOf(host)).docs).toBe(0);

    const first = idsOf(await insert(harness.headersA, host, { placement: "end", markdown: "One\n\nTwo" }));
    expect(first).toHaveLength(2);
    expect((await stateOf(host)).docs).toBe(1);
    const second = idsOf(await insert(harness.headersA, host, { placement: "end", markdown: "Three" }));

    const blocks = await blocksOf(host);
    expect(blocks.map((block) => block.id)).toEqual([...first, ...second]);
    expect(blocks.map((block) => block.text)).toEqual(["One", "Two", "Three"]);
  });

  it("places blocks at the start and directly after a given block", async () => {
    const host = await harness.createHost(harness.tenantA);
    await runInTenant(harness.tenantA, () => writePageTextBlocks(harness.runtime, host, ["A", "B", "C"]));
    const [a, b] = await blocksOf(host);
    if (!a || !b) throw new Error("Missing seed blocks");

    const start = idsOf(await insert(harness.headersA, host, { placement: "start", markdown: "Start" }));
    const after = idsOf(
      await insert(harness.headersA, host, { placement: { afterBlockId: a.id }, markdown: "After A\n\nStill after" }),
    );

    expect((await blocksOf(host)).map((block) => block.text)).toEqual([
      "Start",
      "A",
      "After A",
      "Still after",
      "B",
      "C",
    ]);
    expect(start).toHaveLength(1);
    expect(after).toHaveLength(2);
  });

  it("refuses an unknown afterBlockId with 400 and leaves the page unchanged", async () => {
    const host = await harness.createHost(harness.tenantA);
    await runInTenant(harness.tenantA, () => writePageTextBlocks(harness.runtime, host, ["Only"]));
    const before = { state: await stateOf(host), blocks: await blocksOf(host) };

    const refused = await insert(harness.headersA, host, {
      placement: { afterBlockId: randomUUID() },
      markdown: "Never written",
    });

    expect(refused.status).toBe(400);
    expect(errorBody.parse(JSON.parse(refused.text)).error.code).toBe("validation_failed");
    expect({ state: await stateOf(host), blocks: await blocksOf(host) }).toEqual(before);
  });

  it("uses the caller's ids, refuses an id already in the page with 409 and writes nothing", async () => {
    const host = await harness.createHost(harness.tenantA);
    const ids = idsOf(
      await insert(harness.headersA, host, {
        placement: "end",
        markdown: "One\n\nTwo",
        blockIds: ["mine-1", "mine-2"],
      }),
    );
    expect(ids).toEqual(["mine-1", "mine-2"]);
    expect((await blocksOf(host)).map((block) => block.id)).toEqual(["mine-1", "mine-2"]);

    const before = await stateOf(host);
    const collision = await insert(harness.headersA, host, {
      placement: "end",
      markdown: "Three\n\nFour",
      blockIds: ["fresh", "mine-2"],
    });
    expect(collision.status).toBe(409);
    expect(await stateOf(host)).toEqual(before);
    expect((await blocksOf(host)).map((block) => block.id)).toEqual(["mine-1", "mine-2"]);
  });

  it("refuses a blockIds list that does not match the blocks or repeats an id, with 400", async () => {
    const host = await harness.createHost(harness.tenantA);
    for (const blockIds of [["only-one"], ["a", "b", "c"], ["same", "same"]]) {
      const refused = await insert(harness.headersA, host, { placement: "end", markdown: "One\n\nTwo", blockIds });
      expect(refused.status, JSON.stringify(blockIds)).toBe(400);
      expect(errorBody.parse(JSON.parse(refused.text)).error.details).toMatchObject({ field: "blockIds" });
    }
    expect((await stateOf(host)).docs).toBe(0);
  });

  it("generates the ids and ignores one named in a block comment of the Markdown", async () => {
    const host = await harness.createHost(harness.tenantA);
    const ids = idsOf(
      await insert(harness.headersA, host, {
        placement: "end",
        markdown: "<!-- semprec:block id=smuggled -->\nText",
      }),
    );
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe("smuggled");
    expect((await blocksOf(host)).map((block) => block.id)).toEqual(ids);
  });

  it("refuses a disallowed block type and a page link with 400, writing nothing and creating no document", async () => {
    const host = await harness.createHost(harness.tenantA);
    const before = await stateOf(host);
    for (const markdown of [
      "<!-- semprec:block type=table -->\nCell",
      `[Subpage](semprec://page/${randomUUID()})`,
      `Fine first line\n\n[Subpage](semprec://page/${randomUUID()})`,
    ]) {
      const refused = await insert(harness.headersA, host, { placement: "end", markdown });
      expect(refused.status, markdown).toBe(400);
      const body = errorBody.parse(JSON.parse(refused.text));
      expect(body.error.code).toBe("validation_failed");
      // Names the request field and the offending line or block, never the Markdown itself.
      expect(body.error.details).toMatchObject({ field: "markdown", path: expect.stringMatching(/^(line|block) \d+/) });
      expect(refused.text).not.toContain("Cell");
      expect(await stateOf(host)).toEqual(before);
    }
    expect(before.docs).toBe(0);
  });

  it("answers Markdown with no block with an empty list, writing nothing and creating no document", async () => {
    const host = await harness.createHost(harness.tenantA);
    const before = await stateOf(host);
    expect(idsOf(await insert(harness.headersA, host, { placement: "end", markdown: "" }))).toEqual([]);
    expect(idsOf(await insert(harness.headersA, host, { placement: "end", markdown: " \n\n " }))).toEqual([]);
    expect(await stateOf(host)).toEqual(before);
  });

  it("attributes the stored update to the session user, and to ai_agent for a run credential over /mcp", async () => {
    const host = await harness.createHost(harness.tenantA);
    idsOf(await insert(harness.headersA, host, { placement: "end", markdown: "By the user" }));
    expect(await lastUpdateAuthor(host)).toBe("user");

    const token = await harness.mintRunCredential(harness.tenantA, ["core.page.write"]);
    const response = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "semprec.page.insert",
          arguments: { itemId: host, placement: "end", markdown: "By the agent" },
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain('"error"');
    expect(await lastUpdateAuthor(host)).toBe("ai_agent");
    expect((await blocksOf(host)).map((block) => block.text)).toEqual(["By the user", "By the agent"]);
  });

  it("answers an item of another tenant exactly like an unknown id, a trashed item with 404, and 401 without a session", async () => {
    const hostA = await harness.createHost(harness.tenantA);
    const before = await stateOf(hostA);
    const unknown = randomUUID();
    const foreign = await insert(harness.headersB, hostA, { placement: "end", markdown: "Intrusion" });
    const missing = await insert(harness.headersB, unknown, { placement: "end", markdown: "Intrusion" });
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.text.replaceAll(hostA, "<id>")).toBe(missing.text.replaceAll(unknown, "<id>"));
    expect(await stateOf(hostA)).toEqual(before);

    const trashed = await harness.createHost(harness.tenantA);
    await trash(trashed);
    expect((await insert(harness.headersA, trashed, { placement: "end", markdown: "Late" })).status).toBe(404);

    expect((await insert(undefined, hostA, { placement: "end", markdown: "Anonymous" })).status).toBe(401);
  });

  it("refuses a malformed body with 400: unknown field, bad placement, non-string Markdown", async () => {
    const host = await harness.createHost(harness.tenantA);
    for (const body of [
      { placement: "end", markdown: "x", extra: true },
      { placement: "middle", markdown: "x" },
      { placement: { afterBlockId: "" }, markdown: "x" },
      { placement: "end", markdown: 5 },
      { markdown: "x" },
    ]) {
      expect((await insert(harness.headersA, host, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await stateOf(host)).docs).toBe(0);
  });

  describe("item links", () => {
    async function createTarget(tenantId: string): Promise<string> {
      return harness.createHost(tenantId);
    }

    it("accepts a live local target and refuses unknown, foreign, deleted and malformed targets with identical 400 bodies", async () => {
      const host = await harness.createHost(harness.tenantA);
      const local = await createTarget(harness.tenantA);
      const foreign = await createTarget(harness.tenantB);
      const deleted = await createTarget(harness.tenantA);
      await trash(deleted);

      const accepted = await insert(harness.headersA, host, {
        placement: "end",
        markdown: `See [the target](semprec://items/${local})`,
      });
      expect(accepted.status, accepted.text).toBe(200);

      const before = await stateOf(host);
      const refusals: Inserted[] = [];
      for (const target of [randomUUID(), foreign, deleted, "not-a-uuid"]) {
        refusals.push(
          await insert(harness.headersA, host, { placement: "end", markdown: `Bad [link](semprec://items/${target})` }),
        );
      }
      for (const refusal of refusals) {
        expect(refusal.status, refusal.text).toBe(400);
        expect(refusal.text).toBe(refusals[0]?.text);
      }
      const body = errorBody.parse(JSON.parse(refusals[0]?.text ?? "{}"));
      expect(body.error.code).toBe("validation_failed");
      expect(body.error.details).toEqual({ field: "markdown" });
      expect(await stateOf(host)).toEqual(before);
    });

    it("refuses an invalid link on the first insert without creating the document", async () => {
      const host = await harness.createHost(harness.tenantA);
      const before = await stateOf(host);
      const refused = await insert(harness.headersA, host, {
        placement: "end",
        markdown: `[Gone](semprec://items/${randomUUID()})`,
      });
      expect(refused.status).toBe(400);
      expect(await stateOf(host)).toEqual(before);
      expect(before.docs).toBe(0);
    });
  });

  describe("callers of the HTTP route", () => {
    const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

    it("authors an agent run credential's insert as ai_agent when it holds core.page.write", async () => {
      const host = await harness.createHost(harness.tenantA);
      const token = await harness.mintRunCredential(harness.tenantA, ["core.page.write"]);

      const ids = idsOf(await insert(bearer(token), host, { placement: "end", markdown: "By the run" }));

      expect(ids).toHaveLength(1);
      expect(await lastUpdateAuthor(host)).toBe("ai_agent");
      expect((await blocksOf(host)).map((block) => block.text)).toEqual(["By the run"]);
    });

    it("answers a credential without core.page.write like an unknown operation, writing nothing", async () => {
      const host = await harness.createHost(harness.tenantA);
      const token = await harness.mintRunCredential(harness.tenantA, ["core.page.read"]);
      const before = await stateOf(host);

      const refused = await insert(bearer(token), host, { placement: "end", markdown: "Not granted" });

      expect(refused.status).toBe(404);
      expect(errorBody.parse(JSON.parse(refused.text)).error.code).toBe("not_found");
      expect(await stateOf(host)).toEqual(before);
    });

    it("answers a credential of another tenant exactly like an unknown item", async () => {
      const hostB = await harness.createHost(harness.tenantB);
      const token = await harness.mintRunCredential(harness.tenantA, ["core.page.write"]);
      const foreign = await insert(bearer(token), hostB, { placement: "end", markdown: "Foreign" });
      const unknown = await insert(bearer(token), randomUUID(), { placement: "end", markdown: "Unknown" });

      expect(foreign.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(foreign.text.replaceAll(hostB, "<id>")).toBe(unknown.text.replace(/[0-9a-f-]{36}/, "<id>"));
    });

    it("keeps authenticating a session by cookie or bearer as a person, and refuses an unknown bearer token", async () => {
      const host = await harness.createHost(harness.tenantA);
      const sessionToken = harness.headersA.Authorization.replace("Bearer ", "");

      idsOf(
        await insert({ Cookie: `semprec_session=${sessionToken}` }, host, { placement: "end", markdown: "Cookie" }),
      );
      expect(await lastUpdateAuthor(host)).toBe("user");
      idsOf(await insert(harness.headersA, host, { placement: "end", markdown: "Bearer" }));
      expect(await lastUpdateAuthor(host)).toBe("user");

      const before = await stateOf(host);
      expect((await insert(bearer("not-a-token"), host, { placement: "end", markdown: "x" })).status).toBe(401);
      expect(await stateOf(host)).toEqual(before);
    });
  });

  describe("placement and ids (issue #1679 repair)", () => {
    async function indentsOf(itemId: string): Promise<Array<[string, number]>> {
      const { rows } = await runInTenant(harness.tenantA, () =>
        harness.runtime.query<{ id: string }>(`SELECT id FROM docs WHERE item_id = $1`, [itemId]),
      );
      const docId = rows[0]?.id;
      if (!docId) throw new Error("Missing document");
      return runInTenant(harness.tenantA, async () => {
        const doc = await loadYDoc(harness.runtime, docId);
        try {
          // Read through the document's own maps: this package does not import the block model.
          const blocks = doc.getMap<Y.Map<unknown>>("blocks");
          return doc
            .getArray<string>("order")
            .toArray()
            .flatMap((id): Array<[string, number]> => {
              const block = blocks.get(id);
              if (!(block instanceof Y.Map)) return [];
              const text = block.get("text");
              const indent = block.get("indent");
              return [[text instanceof Y.Text ? String(text.toJSON()) : "", typeof indent === "number" ? indent : 0]];
            });
        } finally {
          doc.destroy();
        }
      });
    }

    /** A page whose block "Deep" is at indent 2, made through the route with a nested list. */
    async function hostWithDeepBlock(): Promise<{ host: string; deepId: string }> {
      const host = await harness.createHost(harness.tenantA);
      const ids = idsOf(
        await insert(harness.headersA, host, { placement: "end", markdown: "- Top\n  - Mid\n    - Deep\n\nTail" }),
      );
      expect(await indentsOf(host)).toEqual([
        ["Top", 0],
        ["Mid", 1],
        ["Deep", 2],
        ["Tail", 0],
      ]);
      const deepId = ids[2];
      if (!deepId) throw new Error("Missing the nested block id");
      return { host, deepId };
    }

    it("anchors plain and nested input at the level of the block it follows", async () => {
      const { host, deepId } = await hostWithDeepBlock();
      idsOf(await insert(harness.headersA, host, { placement: { afterBlockId: deepId }, markdown: "Plain" }));
      idsOf(await insert(harness.headersA, host, { placement: { afterBlockId: deepId }, markdown: "- Up\n  - Down" }));

      expect(await indentsOf(host)).toEqual([
        ["Top", 0],
        ["Mid", 1],
        ["Deep", 2],
        ["Up", 2],
        ["Down", 3],
        ["Plain", 2],
        ["Tail", 0],
      ]);
    });

    it("keeps the parsed indentation at the start and at the end", async () => {
      const { host } = await hostWithDeepBlock();
      idsOf(await insert(harness.headersA, host, { placement: "end", markdown: "- Last\n  - Child" }));
      idsOf(await insert(harness.headersA, host, { placement: "start", markdown: "First" }));

      expect((await indentsOf(host)).filter(([text]) => ["First", "Last", "Child"].includes(text))).toEqual([
        ["First", 0],
        ["Last", 0],
        ["Child", 1],
      ]);
    });

    it("refuses nested input that would pass the maximum indentation, writing nothing", async () => {
      const host = await harness.createHost(harness.tenantA);
      const markdown = "- L0\n  - L1\n    - L2\n      - L3\n        - L4\n          - L5";
      const ids = idsOf(await insert(harness.headersA, host, { placement: "end", markdown }));
      const lastId = ids[5];
      if (!lastId) throw new Error("Missing the deepest block id");
      const before = { state: await stateOf(host), blocks: await indentsOf(host) };

      const refused = await insert(harness.headersA, host, {
        placement: { afterBlockId: lastId },
        markdown: "- A\n  - B",
      });

      expect(refused.status).toBe(400);
      expect(errorBody.parse(JSON.parse(refused.text)).error.details).toMatchObject({
        field: "markdown",
        path: "block 2: indent",
        reason: "invalid_indent",
      });
      expect({ state: await stateOf(host), blocks: await indentsOf(host) }).toEqual(before);
    });

    it("counts one supplied id for every parsed block, indented ones included", async () => {
      const host = await harness.createHost(harness.tenantA);
      const markdown = "- a\n  - b";

      const short = await insert(harness.headersA, host, { placement: "end", markdown, blockIds: ["only-one"] });
      expect(short.status).toBe(400);
      expect(errorBody.parse(JSON.parse(short.text)).error.details).toMatchObject({ field: "blockIds" });
      expect((await stateOf(host)).docs).toBe(0);

      expect(
        idsOf(await insert(harness.headersA, host, { placement: "end", markdown, blockIds: ["x1", "x2"] })),
      ).toEqual(["x1", "x2"]);
    });

    it("validates the placement of empty Markdown without creating or changing anything", async () => {
      const host = await harness.createHost(harness.tenantA);
      const noPage = await insert(harness.headersA, host, { placement: { afterBlockId: "ghost" }, markdown: "" });
      expect(noPage.status).toBe(400);
      expect(errorBody.parse(JSON.parse(noPage.text)).error.details).toMatchObject({
        field: "placement.afterBlockId",
      });
      expect((await stateOf(host)).docs).toBe(0);

      const [known] = idsOf(await insert(harness.headersA, host, { placement: "end", markdown: "Real" }));
      if (!known) throw new Error("Missing the block id");
      const before = await stateOf(host);
      const unknown = await insert(harness.headersA, host, { placement: { afterBlockId: "ghost" }, markdown: " \n " });
      expect(unknown.status).toBe(400);
      expect(idsOf(await insert(harness.headersA, host, { placement: { afterBlockId: known }, markdown: "" }))).toEqual(
        [],
      );
      expect(idsOf(await insert(harness.headersA, host, { placement: "end", markdown: "" }))).toEqual([]);
      expect(await stateOf(host)).toEqual(before);
    });
  });
});
