import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { runInTenant } from "@semprec/shared";
import { writePageTextBlocks } from "@semprec/data/testSupport";
import { createDocStore, docEtag, loadYDoc, mutateYDoc } from "@semprec/data";
import { PageHttpHarness } from "./pageHttpHarness.js";

const harness = new PageHttpHarness();

async function readMd(headers: Record<string, string> | undefined, itemId: string): Promise<Response> {
  return fetch(`${harness.baseUrl}/api/items/${itemId}/page.md`, { headers });
}

describe("GET /api/items/:id/page.md (issue #1678)", () => {
  beforeAll(() => harness.start());
  beforeEach(() => harness.reset());
  afterAll(() => harness.stop());

  it("answers 200 with the canonical Markdown of the blocks, a strong ETag and no title", async () => {
    const host = await harness.createHost(harness.tenantA);
    await runInTenant(harness.tenantA, () =>
      writePageTextBlocks(harness.runtime, host, ["First point", "Second point"]),
    );
    const docId = await harness.docIdOf(harness.tenantA, host);
    await runInTenant(harness.tenantA, () =>
      mutateYDoc(harness.runtime, docId, "user", (ydoc) => ydoc.getMap("meta").set("title", "The page title")),
    );

    const response = await readMd(harness.headersA, host);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("etag")).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    const body = await response.text();
    expect(body).toBe("First point\n\nSecond point");
    expect(body).not.toContain("The page title");
  });

  it("returns the same ETag for two reads with a compaction between them", async () => {
    const host = await harness.createHost(harness.tenantA);
    await runInTenant(harness.tenantA, () => writePageTextBlocks(harness.runtime, host, ["one", "two"]));
    const docId = await harness.docIdOf(harness.tenantA, host);
    const first = await readMd(harness.headersA, host);
    await first.text();

    // A compaction rewrites storage, not the page: the pending updates are gone afterwards.
    await runInTenant(harness.tenantA, () => loadYDoc(harness.runtime, docId, 1));
    const pending = await runInTenant(harness.tenantA, () =>
      harness.runtime.query<{ n: number }>(`SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1`, [docId]),
    );
    expect(pending.rows[0]?.n).toBe(0);

    const second = await readMd(harness.headersA, host);
    expect(second.headers.get("etag")).toBe(first.headers.get("etag"));
    expect(await second.text()).toBe("one\n\ntwo");
  });

  it("returns a different ETag after a write that only deletes text", async () => {
    const host = await harness.createHost(harness.tenantA);
    await runInTenant(harness.tenantA, () => writePageTextBlocks(harness.runtime, host, ["abcdef"]));
    const docId = await harness.docIdOf(harness.tenantA, host);
    const before = await readMd(harness.headersA, host);
    await before.text();

    await runInTenant(harness.tenantA, () =>
      mutateYDoc(harness.runtime, docId, "user", (ydoc) => {
        const [block] = [...ydoc.getMap<Y.Map<unknown>>("blocks").values()];
        const text = block?.get("text");
        if (!(text instanceof Y.Text)) throw new Error("expected the block text to be a Y.Text");
        text.delete(0, 3);
      }),
    );

    const after = await readMd(harness.headersA, host);
    expect(await after.text()).toBe("def");
    expect(after.headers.get("etag")).not.toBe(before.headers.get("etag"));
  });

  it("answers 200 with an empty body for an item without a document and creates no docs row", async () => {
    const host = await harness.createHost(harness.tenantA);
    const response = await readMd(harness.headersA, host);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("etag")).toBe(`"${docEtag(new Y.Doc())}"`);
    const docs = await runInTenant(harness.tenantA, () =>
      harness.runtime.query(`SELECT 1 FROM docs WHERE item_id = $1`, [host]),
    );
    expect(docs.rows).toHaveLength(0);
  });

  it("answers an item of another tenant exactly like an unknown id, with 404", async () => {
    const hostA = await harness.createHost(harness.tenantA);
    await runInTenant(harness.tenantA, () => writePageTextBlocks(harness.runtime, hostA, ["A's secret page"]));
    const unknown = randomUUID();
    const foreign = await readMd(harness.headersB, hostA);
    const missing = await readMd(harness.headersB, unknown);
    const foreignText = await foreign.text();
    const missingText = await missing.text();
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreignText.replaceAll(hostA, "<id>")).toBe(missingText.replaceAll(unknown, "<id>"));
    expect(foreignText).not.toContain("secret");
    expect(foreign.headers.get("content-type")).toBe(missing.headers.get("content-type"));
    expect(foreign.headers.get("etag")).toBeNull();
    // The owner still reads it.
    expect(await (await readMd(harness.headersA, hostA)).text()).toBe("A's secret page");
  });

  it("answers 401 without a session and 400 for a malformed id", async () => {
    const host = await harness.createHost(harness.tenantA);
    expect((await readMd(undefined, host)).status).toBe(401);
    expect((await readMd(harness.headersA, "not-a-uuid")).status).toBe(400);
  });

  it("answers 400 for an item that already holds a canvas document", async () => {
    const host = await harness.createHost(harness.tenantA);
    await runInTenant(harness.tenantA, () => createDocStore(harness.runtime).getOrCreateDoc(host, "canvas"));
    const response = await readMd(harness.headersA, host);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "validation_failed" } });
  });

  it("is the same read as page.get with format markdown", async () => {
    const host = await harness.createHost(harness.tenantA);
    await runInTenant(harness.tenantA, () => writePageTextBlocks(harness.runtime, host, ["via the catalog"]));
    const viaRoute = await readMd(harness.headersA, host);
    const viaCatalog = await fetch(`${harness.baseUrl}/api/items/${host}/page?format=markdown`, {
      headers: harness.headersA,
    });
    expect(viaCatalog.status).toBe(200);
    expect(await viaCatalog.json()).toMatchObject({
      kind: "page",
      markdown: await viaRoute.text(),
      etag: viaRoute.headers.get("etag")?.slice(1, -1),
    });
  });
});
