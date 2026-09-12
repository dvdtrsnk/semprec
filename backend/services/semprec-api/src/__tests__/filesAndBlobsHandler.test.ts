import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createUser,
  createViewTypeRegistry,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  seedSystem,
  type PasswordResetMailer,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

const PASSWORD = "s3cret-password";
const MAX_FILE_SIZE_BYTES = 1024;

const noopMailer: PasswordResetMailer = {
  async sendPasswordResetEmail() {},
};

let pool: Pool;
const moduleRegistry = await loadFullModuleRegistry();

async function authHeader(): Promise<{ Authorization: string }> {
  const user = await createUser(pool, {
    email: `${randomUUID()}@example.com`,
    passwordHash: await hashPassword(PASSWORD),
  });
  const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  return { Authorization: `Bearer ${token}` };
}

interface ItemBody {
  id: string;
  databaseId: string;
  properties: Record<string, unknown>;
}

interface ErrorBody {
  error: { code: string; details?: unknown };
}

describe("files and blobs routes (issue #158)", () => {
  let server: Server;
  let baseUrl: string;
  let tmpBlobDir: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());

    tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);
    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "http://localhost",
      setupToken: "unused-setup-token",
      moduleRegistry,
      blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
      maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
    });
    server = createServer(dispatch);
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

  async function uploadFile(body: string, opts: { filename?: string; contentType?: string } = {}) {
    const headers = {
      ...(await authHeader()),
      "Content-Type": opts.contentType ?? "text/plain",
      "X-Filename": opts.filename ?? "hello.txt",
    };
    return fetch(`${baseUrl}/api/files`, { method: "POST", headers, body, duplex: "half" });
  }

  describe("POST /api/files", () => {
    it("rejects an unauthenticated request", async () => {
      const res = await fetch(`${baseUrl}/api/files`, {
        method: "POST",
        headers: { "Content-Type": "text/plain", "X-Filename": "a.txt" },
        body: "hi",
      });
      expect(res.status).toBe(401);
    });

    it("streams an upload and creates a Files item, 201", async () => {
      const res = await uploadFile("hello world", { filename: "hello.txt", contentType: "text/plain" });
      expect(res.status).toBe(201);
      const body = (await res.json()) as ItemBody;
      expect(body.properties.name).toBe("hello.txt");
      expect(body.properties.file).toMatchObject({ blobId: expect.any(String) });
    });

    it("rejects a payload over Content-Length before reading the body (413)", async () => {
      const oversized = "x".repeat(MAX_FILE_SIZE_BYTES + 100);
      const res = await uploadFile(oversized);
      expect(res.status).toBe(413);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("payload_too_large");
    });

    it("rejects an X-Filename over the safe storage-key length with 400, not a filesystem error", async () => {
      const res = await uploadFile("hi", { filename: "x".repeat(500) });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("validation_failed");
    });

    it("rejects a chunked upload with no Content-Length that exceeds the limit via the streaming counter, leaving no partial blob or row", async () => {
      const headers = {
        ...(await authHeader()),
        "Content-Type": "text/plain",
        "X-Filename": "big.txt",
      };
      const oversized = "y".repeat(MAX_FILE_SIZE_BYTES * 2);
      const stream = Readable.from(
        (async function* () {
          // Yielding in small chunks with no declared length forces `fetch` to use chunked
          // transfer-encoding, so no `Content-Length` header precheck can catch this — only
          // the always-on streaming byte counter can.
          for (let i = 0; i < oversized.length; i += 16) {
            yield oversized.slice(i, i + 16);
          }
        })(),
      );

      const res = await fetch(`${baseUrl}/api/files`, {
        method: "POST",
        headers,
        body: stream,
        duplex: "half",
      });
      expect(res.status).toBe(413);

      const { rows: blobRows } = await pool.query("SELECT count(*)::int AS n FROM blobs");
      expect(blobRows[0].n).toBe(0);
      const { rows: itemRows } = await pool.query(
        "SELECT count(*)::int AS n FROM items WHERE properties -> 'file' ->> 'blobId' IS NOT NULL",
      );
      expect(itemRows[0].n).toBe(0);
    });

    it("converges concurrent identical uploads onto one blob and one deterministic Files item", async () => {
      const content = "same bytes every time";
      const [first, second] = await Promise.all([
        uploadFile(content, { filename: "dup.txt" }),
        uploadFile(content, { filename: "dup.txt" }),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 201]);

      const firstBody = (await first.json()) as ItemBody;
      const secondBody = (await second.json()) as ItemBody;
      expect(secondBody.id).toBe(firstBody.id);

      const { rows: blobRows } = await pool.query("SELECT count(*)::int AS n FROM blobs");
      expect(blobRows[0].n).toBe(1);
    });

    it("reuses the existing Files row (lowest id) when the same content is uploaded again later", async () => {
      const content = "reupload me";
      const first = await uploadFile(content, { filename: "a.txt" });
      expect(first.status).toBe(201);
      const firstBody = (await first.json()) as ItemBody;

      const second = await uploadFile(content, { filename: "a-again.txt" });
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as ItemBody;
      expect(secondBody.id).toBe(firstBody.id);
    });
  });

  describe("GET /api/blobs/:id", () => {
    async function uploadAndGetBlobId(content: string, opts?: { filename?: string; contentType?: string }) {
      const res = await uploadFile(content, opts);
      const body = (await res.json()) as ItemBody;
      return (body.properties.file as { blobId: string }).blobId;
    }

    it("rejects an unauthenticated request", async () => {
      const blobId = await uploadAndGetBlobId("abc");
      const res = await fetch(`${baseUrl}/api/blobs/${blobId}`);
      expect(res.status).toBe(401);
    });

    it("returns 404 for an unknown blob id", async () => {
      const headers = await authHeader();
      const res = await fetch(`${baseUrl}/api/blobs/${randomUUID()}`, { headers });
      expect(res.status).toBe(404);
    });

    it("does not dispatch DELETE or PATCH to the download handler", async () => {
      const headers = await authHeader();
      const blobId = await uploadAndGetBlobId("do not delete me");

      const deleteRes = await fetch(`${baseUrl}/api/blobs/${blobId}`, { method: "DELETE", headers });
      expect(deleteRes.status).not.toBe(200);
      expect(deleteRes.status).not.toBe(206);

      const patchRes = await fetch(`${baseUrl}/api/blobs/${blobId}`, { method: "PATCH", headers });
      expect(patchRes.status).not.toBe(200);
      expect(patchRes.status).not.toBe(206);
    });

    it("downloads the full blob with a safe attachment Content-Disposition and nosniff", async () => {
      const headers = await authHeader();
      const blobId = await uploadAndGetBlobId("hello world", { filename: "hello.txt", contentType: "text/plain" });

      const res = await fetch(`${baseUrl}/api/blobs/${blobId}`, { headers });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("hello world");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-disposition")).toContain('attachment; filename="hello.txt"');
      expect(res.headers.get("etag")).toBeTruthy();
    });

    it("serves a valid byte range with 206 and Content-Range", async () => {
      const headers = await authHeader();
      const blobId = await uploadAndGetBlobId("0123456789", { filename: "digits.txt" });

      const res = await fetch(`${baseUrl}/api/blobs/${blobId}`, { headers: { ...headers, Range: "bytes=2-4" } });
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe("bytes 2-4/10");
      expect(await res.text()).toBe("234");
    });

    it("rejects an out-of-bounds range with 416", async () => {
      const headers = await authHeader();
      const blobId = await uploadAndGetBlobId("0123456789", { filename: "digits.txt" });

      const res = await fetch(`${baseUrl}/api/blobs/${blobId}`, { headers: { ...headers, Range: "bytes=100-200" } });
      expect(res.status).toBe(416);
      expect(res.headers.get("content-range")).toBe("bytes */10");
    });

    it("rejects a zero-length suffix range (bytes=-0) with 416, per RFC 7233 §2.1", async () => {
      const headers = await authHeader();
      const blobId = await uploadAndGetBlobId("0123456789", { filename: "digits.txt" });

      const res = await fetch(`${baseUrl}/api/blobs/${blobId}`, { headers: { ...headers, Range: "bytes=-0" } });
      expect(res.status).toBe(416);
      expect(res.headers.get("content-range")).toBe("bytes */10");
    });

    it("ignores a malformed Range header and serves the full body", async () => {
      const headers = await authHeader();
      const blobId = await uploadAndGetBlobId("0123456789", { filename: "digits.txt" });

      const res = await fetch(`${baseUrl}/api/blobs/${blobId}`, { headers: { ...headers, Range: "not-a-range" } });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("0123456789");
    });

    it("returns 304 when If-None-Match matches the current ETag", async () => {
      const headers = await authHeader();
      const blobId = await uploadAndGetBlobId("etag me", { filename: "e.txt" });

      const first = await fetch(`${baseUrl}/api/blobs/${blobId}`, { headers });
      const etag = first.headers.get("etag");
      expect(etag).toBeTruthy();

      const res = await fetch(`${baseUrl}/api/blobs/${blobId}`, { headers: { ...headers, "If-None-Match": etag! } });
      expect(res.status).toBe(304);
    });

    it("honors ?disposition=inline only for an allowlisted MIME type", async () => {
      const headers = await authHeader();
      const pngBlobId = await uploadAndGetBlobId("fake-png-bytes", { filename: "pic.png", contentType: "image/png" });

      const inline = await fetch(`${baseUrl}/api/blobs/${pngBlobId}?disposition=inline`, { headers });
      expect(inline.headers.get("content-disposition")).toContain("inline;");
    });

    it("ignores ?disposition=inline for a MIME type outside the allowlist (e.g. text/html, to avoid inline stored-XSS)", async () => {
      const headers = await authHeader();
      const htmlBlobId = await uploadAndGetBlobId("<script>evil()</script>", {
        filename: "evil.html",
        contentType: "text/html",
      });

      const res = await fetch(`${baseUrl}/api/blobs/${htmlBlobId}?disposition=inline`, { headers });
      expect(res.headers.get("content-disposition")).toContain("attachment;");
    });

    it("percent-encodes and ASCII-sanitizes a malicious filename in Content-Disposition instead of injecting header syntax", async () => {
      const headers = await authHeader();
      const maliciousName = 'evil".txt"; filename="x';
      const blobId = await uploadAndGetBlobId("payload", { filename: maliciousName });

      const res = await fetch(`${baseUrl}/api/blobs/${blobId}`, { headers });
      const disposition = res.headers.get("content-disposition")!;
      expect(disposition).not.toContain('"; filename="x');
      expect(disposition).toContain('filename="evil_.txt_; filename=_x"');
    });
  });
});
