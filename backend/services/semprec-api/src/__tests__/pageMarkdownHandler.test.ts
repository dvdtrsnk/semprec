import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import * as Y from "yjs";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  writePageTextBlocks,
} from "@semprec/data/testSupport";
import {
  createChokePoint,
  createDocStore,
  createUser,
  docEtag,
  hashPassword,
  loadFullModuleRegistry,
  loadYDoc,
  LocalFsBlobStorageWriter,
  login,
  mutateYDoc,
  type PasswordResetMailer,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

const PASSWORD = "s3cret-password";
const tmpBlobDir = join(tmpdir(), `semprec-test-page-markdown-${randomUUID()}`);
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();

let admin: Pool;
let runtime: Pool;
let server: Server;
let baseUrl: string;
let tenantA: string;
let tenantB: string;
let headersA: { Authorization: string };
let headersB: { Authorization: string };

async function signIn(tenantId: string): Promise<{ Authorization: string }> {
  const email = `${randomUUID()}@example.com`;
  await createUser(admin, { email, passwordHash: await hashPassword(PASSWORD), tenantId });
  const { token } = await login(admin, { email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  return { Authorization: `Bearer ${token}` };
}

/** A plain item of its own database in `tenantId`, the host of the page under test. */
async function createHost(tenantId: string): Promise<string> {
  return runInTenant(tenantId, async () => {
    const chokePoint = createChokePoint(runtime);
    const database = await chokePoint.createDatabase({ name: `Pages of ${randomUUID()}` });
    return (await chokePoint.createItem({ databaseId: database.id, properties: {} })).id;
  });
}

async function docIdOf(tenantId: string, itemId: string): Promise<string> {
  const { rows } = await runInTenant(tenantId, () =>
    runtime.query<{ id: string }>(`SELECT id FROM docs WHERE item_id = $1`, [itemId]),
  );
  const row = rows[0];
  if (!row) throw new Error(`Item ${itemId} has no document`);
  return row.id;
}

async function readMd(headers: Record<string, string> | undefined, itemId: string): Promise<Response> {
  return fetch(`${baseUrl}/api/items/${itemId}/page.md`, { headers });
}

describe("GET /api/items/:id/page.md (issue #1678)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenantA = await createTestTenant(admin);
    tenantB = await createTestTenant(admin);
    [headersA, headersB] = await Promise.all([signIn(tenantA), signIn(tenantB)]);
    const dispatch = await createDispatcher(runtime, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "http://localhost",
      setupToken: "unused-setup-token",
      moduleRegistry,
      blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
      maxFileSizeBytes: 10 * 1024 * 1024,
    });
    server = createServer(dispatch);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  afterAll(async () => {
    const results = await Promise.allSettled([runtime?.end(), admin?.end()]);
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (errors.length) throw new AggregateError(errors, "Pool cleanup failed", { cause: errors[0] });
  });

  it("answers 200 with the canonical Markdown of the blocks, a strong ETag and no title", async () => {
    const host = await createHost(tenantA);
    await runInTenant(tenantA, () => writePageTextBlocks(runtime, host, ["First point", "Second point"]));
    const docId = await docIdOf(tenantA, host);
    await runInTenant(tenantA, () =>
      mutateYDoc(runtime, docId, "user", (ydoc) => ydoc.getMap("meta").set("title", "The page title")),
    );

    const response = await readMd(headersA, host);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("etag")).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    const body = await response.text();
    expect(body).toBe("First point\n\nSecond point");
    expect(body).not.toContain("The page title");
  });

  it("returns the same ETag for two reads with a compaction between them", async () => {
    const host = await createHost(tenantA);
    await runInTenant(tenantA, () => writePageTextBlocks(runtime, host, ["one", "two"]));
    const docId = await docIdOf(tenantA, host);
    const first = await readMd(headersA, host);
    await first.text();

    // A compaction rewrites storage, not the page: the pending updates are gone afterwards.
    await runInTenant(tenantA, () => loadYDoc(runtime, docId, 1));
    const pending = await runInTenant(tenantA, () =>
      runtime.query<{ n: number }>(`SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1`, [docId]),
    );
    expect(pending.rows[0]?.n).toBe(0);

    const second = await readMd(headersA, host);
    expect(second.headers.get("etag")).toBe(first.headers.get("etag"));
    expect(await second.text()).toBe("one\n\ntwo");
  });

  it("returns a different ETag after a write that only deletes text", async () => {
    const host = await createHost(tenantA);
    await runInTenant(tenantA, () => writePageTextBlocks(runtime, host, ["abcdef"]));
    const docId = await docIdOf(tenantA, host);
    const before = await readMd(headersA, host);
    await before.text();

    await runInTenant(tenantA, () =>
      mutateYDoc(runtime, docId, "user", (ydoc) => {
        const [block] = [...ydoc.getMap<Y.Map<unknown>>("blocks").values()];
        const text = block?.get("text");
        if (!(text instanceof Y.Text)) throw new Error("expected the block text to be a Y.Text");
        text.delete(0, 3);
      }),
    );

    const after = await readMd(headersA, host);
    expect(await after.text()).toBe("def");
    expect(after.headers.get("etag")).not.toBe(before.headers.get("etag"));
  });

  it("answers 200 with an empty body for an item without a document and creates no docs row", async () => {
    const host = await createHost(tenantA);
    const response = await readMd(headersA, host);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("etag")).toBe(`"${docEtag(new Y.Doc())}"`);
    const docs = await runInTenant(tenantA, () => runtime.query(`SELECT 1 FROM docs WHERE item_id = $1`, [host]));
    expect(docs.rows).toHaveLength(0);
  });

  it("answers an item of another tenant exactly like an unknown id, with 404", async () => {
    const hostA = await createHost(tenantA);
    await runInTenant(tenantA, () => writePageTextBlocks(runtime, hostA, ["A's secret page"]));
    const unknown = randomUUID();
    const foreign = await readMd(headersB, hostA);
    const missing = await readMd(headersB, unknown);
    const foreignText = await foreign.text();
    const missingText = await missing.text();
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreignText.replaceAll(hostA, "<id>")).toBe(missingText.replaceAll(unknown, "<id>"));
    expect(foreignText).not.toContain("secret");
    expect(foreign.headers.get("content-type")).toBe(missing.headers.get("content-type"));
    expect(foreign.headers.get("etag")).toBeNull();
    // The owner still reads it.
    expect(await (await readMd(headersA, hostA)).text()).toBe("A's secret page");
  });

  it("answers 401 without a session and 400 for a malformed id", async () => {
    const host = await createHost(tenantA);
    expect((await readMd(undefined, host)).status).toBe(401);
    expect((await readMd(headersA, "not-a-uuid")).status).toBe(400);
  });

  it("answers 400 for an item that already holds a canvas document", async () => {
    const host = await createHost(tenantA);
    await runInTenant(tenantA, () => createDocStore(runtime).getOrCreateDoc(host, "canvas"));
    const response = await readMd(headersA, host);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "validation_failed" } });
  });

  it("is the same read as page.get with format markdown", async () => {
    const host = await createHost(tenantA);
    await runInTenant(tenantA, () => writePageTextBlocks(runtime, host, ["via the catalog"]));
    const viaRoute = await readMd(headersA, host);
    const viaCatalog = await fetch(`${baseUrl}/api/items/${host}/page?format=markdown`, { headers: headersA });
    expect(viaCatalog.status).toBe(200);
    expect(await viaCatalog.json()).toMatchObject({
      kind: "page",
      markdown: await viaRoute.text(),
      etag: viaRoute.headers.get("etag")?.slice(1, -1),
    });
  });
});
