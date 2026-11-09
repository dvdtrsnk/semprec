import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { writePageTextBlocks } from "@semprec/data/testSupport";
import { createDocStore, mutateYDoc } from "@semprec/data";
import { PageHttpHarness } from "./pageHttpHarness.js";

const harness = new PageHttpHarness();

const changesBody = z.array(
  z.object({ at: z.string(), blockIds: z.array(z.string()), kind: z.enum(["insert", "update", "delete"]) }).strict(),
);

interface Answer {
  status: number;
  text: string;
}

async function get(headers: Record<string, string> | undefined, itemId: string, query: string): Promise<Answer> {
  const response = await fetch(`${harness.baseUrl}/api/items/${itemId}/page/changes?${query}`, { headers });
  return { status: response.status, text: await response.text() };
}

/** A host with a page document, and the database clock read once the document exists. */
async function hostWithPage(): Promise<{ host: string; docId: string; since: string }> {
  const host = await harness.createHost(harness.tenantA);
  await runInTenant(harness.tenantA, () => createDocStore(harness.runtime).getOrCreateDoc(host, "page"));
  const docId = await harness.docIdOf(harness.tenantA, host);
  const { rows } = await harness.runtime.query<{ now: Date }>(`SELECT clock_timestamp() AS now`);
  await sleep(15);
  return { host, docId, since: rows[0]!.now.toISOString() };
}

async function writeAs(docId: string, origin: "user" | "ai_agent", fn: (doc: Y.Doc) => void): Promise<void> {
  await runInTenant(harness.tenantA, () => mutateYDoc(harness.runtime, docId, origin, fn));
  await sleep(15);
}

describe("GET /api/items/:id/page/changes (issue #1680)", () => {
  beforeAll(() => harness.start());
  beforeEach(() => harness.reset());
  afterAll(() => harness.stop());

  it("lists the assistant's insert, update and delete by default, and the user's under by=user", async () => {
    const { host, docId, since } = await hostWithPage();
    await writeAs(docId, "ai_agent", (doc) => {
      const blocks = doc.getMap<Y.Map<unknown>>("blocks");
      for (const id of ["a", "b"]) {
        const block = new Y.Map<unknown>();
        block.set("sys:id", id);
        block.set("sys:flavour", "text");
        block.set("text", new Y.Text(id));
        blocks.set(id, block);
        doc.getArray<string>("order").push([id]);
      }
    });
    await writeAs(docId, "ai_agent", (doc) => {
      const text = doc.getMap<Y.Map<unknown>>("blocks").get("a")?.get("text");
      if (!(text instanceof Y.Text)) throw new Error("expected a Y.Text");
      text.insert(1, "!");
    });
    await writeAs(docId, "ai_agent", (doc) => {
      doc.getMap<Y.Map<unknown>>("blocks").delete("b");
      const order = doc.getArray<string>("order");
      order.delete(order.toArray().indexOf("b"), 1);
    });
    await writeAs(docId, "user", (doc) => {
      doc.getMap<Y.Map<unknown>>("blocks").delete("a");
    });

    const agent = await get(harness.headersA, host, `since=${encodeURIComponent(since)}`);
    expect(agent.status, agent.text).toBe(200);
    expect(changesBody.parse(JSON.parse(agent.text)).map(({ kind, blockIds }) => ({ kind, blockIds }))).toEqual([
      { kind: "insert", blockIds: ["a", "b"] },
      { kind: "update", blockIds: ["a"] },
      { kind: "delete", blockIds: ["b"] },
    ]);

    const user = await get(harness.headersA, host, `since=${encodeURIComponent(since)}&by=user`);
    expect(changesBody.parse(JSON.parse(user.text)).map(({ kind, blockIds }) => ({ kind, blockIds }))).toEqual([
      { kind: "delete", blockIds: ["a"] },
    ]);
    const limited = await get(harness.headersA, host, `since=${encodeURIComponent(since)}&limit=1`);
    expect(changesBody.parse(JSON.parse(limited.text))).toHaveLength(1);
  });

  it("answers an item without a page with an empty list, and 400 for a future since", async () => {
    const host = await harness.createHost(harness.tenantA);
    const past = encodeURIComponent(new Date(Date.now() - 60_000).toISOString());
    const empty = await get(harness.headersA, host, `since=${past}`);
    expect(empty.status).toBe(200);
    expect(JSON.parse(empty.text)).toEqual([]);

    const future = await get(
      harness.headersA,
      host,
      `since=${encodeURIComponent(new Date(Date.now() + 3_600_000).toISOString())}`,
    );
    expect(future.status).toBe(400);
    expect(JSON.parse(future.text)).toMatchObject({
      error: { code: "validation_failed", details: { field: "since" } },
    });
  });

  it("answers 400 for a future since of an item with a page, and 410 history_not_retained before its history", async () => {
    const { host, since } = await hostWithPage();
    const future = await get(
      harness.headersA,
      host,
      `since=${encodeURIComponent(new Date(Date.now() + 3_600_000).toISOString())}`,
    );
    expect(future.status).toBe(400);

    const old = await get(
      harness.headersA,
      host,
      `since=${encodeURIComponent(new Date(Date.parse(since) - 86_400_000).toISOString())}`,
    );
    expect(old.status).toBe(410);
    expect(JSON.parse(old.text)).toMatchObject({ error: { code: "history_not_retained" } });
  });

  it("answers 400 for a missing or malformed since, an unknown author and a bad limit", async () => {
    const { host, since } = await hostWithPage();
    const encoded = encodeURIComponent(since);
    for (const [query, field] of [
      ["", "since"],
      ["since=yesterday", "since"],
      ["since=2026-11-09", "since"],
      [`since=${encoded}&by=robot`, "by"],
      [`since=${encoded}&limit=0`, "limit"],
      [`since=${encoded}&limit=501`, "limit"],
      [`since=${encoded}&limit=ten`, "limit"],
    ] as const) {
      const answer = await get(harness.headersA, host, query);
      expect(answer.status, query).toBe(400);
      expect(JSON.parse(answer.text), query).toMatchObject({
        error: { code: "validation_failed", details: { field } },
      });
    }
    expect((await get(harness.headersA, "not-a-uuid", `since=${encoded}`)).status).toBe(400);
  });

  it("answers an item of another tenant exactly like an unknown id, with 404, and 401 without a session", async () => {
    const { host, docId, since } = await hostWithPage();
    await runInTenant(harness.tenantA, () => writePageTextBlocks(harness.runtime, host, ["A's page"]));
    await writeAs(docId, "ai_agent", (doc) => doc.getMap("note").set("k", "v"));
    const query = `since=${encodeURIComponent(since)}`;
    const unknown = randomUUID();

    const foreign = await get(harness.headersB, host, query);
    const missing = await get(harness.headersB, unknown, query);

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.text.replaceAll(host, "<id>")).toBe(missing.text.replaceAll(unknown, "<id>"));
    expect((await get(undefined, host, query)).status).toBe(401);
  });
});
