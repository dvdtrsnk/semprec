import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { writePageTextBlocks } from "@semprec/data/testSupport";
import { createChokePoint, mintMcpRunCredential, seedSystem, withTransaction } from "@semprec/data";
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
      expect(errorBody.parse(JSON.parse(refused.text)).error.code).toBe("validation_failed");
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

  it("attributes the stored update to the session user, and to ai_agent for a run credential", async () => {
    const host = await harness.createHost(harness.tenantA);
    idsOf(await insert(harness.headersA, host, { placement: "end", markdown: "By the user" }));
    expect(await lastUpdateAuthor(host)).toBe("user");

    await runInTenant(harness.tenantA, () => seedSystem(harness.runtime));
    const credential = await runInTenant(harness.tenantA, async () => {
      const chokePoint = createChokePoint(harness.runtime);
      const projects = (await chokePoint.listDatabases()).find((database) => database.ownerModuleId === "projects");
      if (!projects) throw new Error("Projects database was not seeded");
      const project = await chokePoint.createItem({ databaseId: projects.id, properties: {} });
      const { rows } = await harness.runtime.query<{ id: string }>(`SELECT id FROM users WHERE tenant_id = $1`, [
        harness.tenantA,
      ]);
      const userId = rows[0]?.id;
      if (!userId) throw new Error("Missing tenant user");
      return withTransaction(harness.runtime, (client) =>
        mintMcpRunCredential(client, { projectItemId: project.id, capabilities: ["core.page.write"], userId }),
      );
    });
    const response = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
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
      expect(JSON.stringify(body.error.details)).toContain('"path":"markdown"');
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
});
