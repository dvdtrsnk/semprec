import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { PassThrough, type Readable } from "node:stream";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createBlob, createUser, hashPassword, login, type BlobStorageWriter } from "@semprec/data";
import { createBlobsRequestListener } from "../blobsHandler.js";

const PASSWORD = "s3cret-password";

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A `BlobStorageWriter` whose `readStream` hands back a `PassThrough` the test controls directly, so it can assert on `destroyed` once the client aborts. */
class RecordingBlobStorage implements BlobStorageWriter {
  lastReadStream: PassThrough | undefined;

  async writeStream(): Promise<{ byteSize: number; contentHash: string }> {
    throw new Error("not used");
  }

  async delete(): Promise<void> {
    throw new Error("not used");
  }

  readStream(): Readable {
    const passThrough = new PassThrough();
    passThrough.write("chunk-one");
    this.lastReadStream = passThrough;
    return passThrough;
  }
}

describe("GET /api/blobs/:id aborted download (issue #634)", () => {
  let pool: Pool;
  let server: Server;
  let baseUrl: string;
  let storage: RecordingBlobStorage;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);

    storage = new RecordingBlobStorage();
    const listener = createBlobsRequestListener(pool, { storage });
    server = createServer(listener);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function authHeader(): Promise<{ Authorization: string }> {
    const user = await createUser(pool, {
      email: `${randomUUID()}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
    });
    const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    return { Authorization: `Bearer ${token}` };
  }

  async function insertBlob(byteSize: number): Promise<string> {
    const blob = await createBlob(pool, {
      mimeType: "text/plain",
      byteSize,
      storageKey: `abort-test-${randomUUID()}`,
    });
    return blob.id;
  }

  it("destroys the read stream when the client aborts after headers arrive", async () => {
    const headers = await authHeader();
    // Larger than the single chunk written below: the download never completes, so the client
    // aborting mid-stream is what triggers pipeline's premature-close handling, not a natural end.
    const blobId = await insertBlob(1024);

    const controller = new AbortController();
    const responsePromise = fetch(`${baseUrl}/api/blobs/${blobId}`, { headers, signal: controller.signal });
    const res = await responsePromise;
    expect(res.status).toBe(200);

    controller.abort();

    await waitUntil(() => storage.lastReadStream?.destroyed === true, 2000);
    expect(storage.lastReadStream?.destroyed).toBe(true);
  });

  it("still ends the stream normally and serves the full body when the download completes", async () => {
    const headers = await authHeader();
    // Content-Length must match the bytes actually written for the client to see a clean
    // completion rather than a truncated response.
    const blobId = await insertBlob(Buffer.byteLength("chunk-one"));

    const res = await fetch(`${baseUrl}/api/blobs/${blobId}`, { headers });
    expect(res.status).toBe(200);

    storage.lastReadStream!.end();

    const body = await res.text();
    expect(body).toBe("chunk-one");

    await waitUntil(() => storage.lastReadStream?.destroyed === true, 2000);
    expect(storage.lastReadStream?.destroyed).toBe(true);
  });
});
