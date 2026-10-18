import { describe, expect, it } from "vitest";
import { OperationError } from "../genericOperations.js";
import { createAccountOperations } from "../accountOperations.js";

const EXPORT = {
  id: "export-1",
  status: "ready",
  createdAt: "2026-10-18T10:00:00.000Z",
  completedAt: "2026-10-18T10:05:00.000Z",
  expiresAt: "2026-10-25T10:05:00.000Z",
  byteSize: 2048,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function recording(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const operations = createAccountOperations({
    baseUrl: "/api/",
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return response();
    },
  });
  return { operations, calls };
}

function failingWith(response: () => Response) {
  return createAccountOperations({ baseUrl: "/api", fetchImpl: async () => response() });
}

describe("account operations: exports", () => {
  it("listExports gets the caller's exports with same-origin credentials and parses them", async () => {
    const { operations, calls } = recording(() => jsonResponse({ exports: [EXPORT] }));

    await expect(operations.listExports()).resolves.toEqual([EXPORT]);
    expect(calls[0]!.url).toBe("/api/account/exports");
    expect(calls[0]!.init?.credentials).toBe("same-origin");
  });

  it("requestExport resolves the created export on 202", async () => {
    const { operations, calls } = recording(() => jsonResponse({ export: { ...EXPORT, status: "pending" } }, 202));

    await expect(operations.requestExport()).resolves.toEqual({ ...EXPORT, status: "pending" });
    expect(calls[0]!.url).toBe("/api/account/exports");
    expect(calls[0]!.init?.method).toBe("POST");
  });

  it("requestExport resolves the already-running export on 200", async () => {
    const { operations } = recording(() => jsonResponse({ export: { ...EXPORT, status: "running" } }, 200));

    await expect(operations.requestExport()).resolves.toMatchObject({ status: "running" });
  });

  it("exportDownloadUrl encodes the id and makes no request", () => {
    const { operations, calls } = recording(() => jsonResponse({}));

    expect(operations.exportDownloadUrl("a b")).toBe("/api/account/exports/a%20b/download");
    expect(calls).toHaveLength(0);
  });

  it("a 401 on the list is unavailable with its status", async () => {
    const operations = failingWith(() => jsonResponse({ error: { code: "unauthenticated" } }, 401));

    const error = await operations.listExports().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OperationError);
    expect(error).toMatchObject({ kind: "unavailable", status: 401, message: "unauthenticated" });
  });

  it("an unparseable success body is retryable", async () => {
    const operations = failingWith(() => jsonResponse({ exports: [{ id: 1 }] }));

    await expect(operations.listExports()).rejects.toMatchObject({ kind: "retryable" });
  });
});

describe("account operations: error bodies", () => {
  it("falls back to the status message when the error body is over the cap, even if it carries a code", async () => {
    const oversized = { error: { code: "rate_limited" }, padding: "x".repeat(9 * 1024) };
    const operations = failingWith(() => jsonResponse(oversized, 500));

    await expect(operations.listExports()).rejects.toMatchObject({
      kind: "retryable",
      status: 500,
      message: "Request to /account/exports failed with 500",
    });
  });

  it("falls back to the status message when the error body is not JSON", async () => {
    const operations = failingWith(() => new Response("<html>Bad gateway</html>", { status: 502 }));

    await expect(operations.listExports()).rejects.toMatchObject({
      kind: "retryable",
      status: 502,
      message: "Request to /account/exports failed with 502",
    });
  });

  it("falls back to the status message when reading the error body fails", async () => {
    const failingBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("connection reset"));
      },
    });
    const operations = failingWith(() => new Response(failingBody, { status: 500 }));

    await expect(operations.listExports()).rejects.toMatchObject({
      kind: "retryable",
      status: 500,
      message: "Request to /account/exports failed with 500",
    });
  });
});

describe("account operations: deletion", () => {
  it("deleteAccount posts the password and resolves on 202", async () => {
    const { operations, calls } = recording(() => jsonResponse({ status: "deleting" }, 202));

    await expect(operations.deleteAccount("pw")).resolves.toBeUndefined();
    expect(calls[0]!.url).toBe("/api/account/delete");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ password: "pw" });
  });

  it("a 403 re-authentication refusal is unavailable with status 403", async () => {
    const operations = failingWith(() => jsonResponse({ error: { code: "reauthentication_failed" } }, 403));

    await expect(operations.deleteAccount("wrong")).rejects.toMatchObject({
      kind: "unavailable",
      status: 403,
    });
  });

  it("a 409 last_admin rejects as retryable with the code as its message", async () => {
    const operations = failingWith(() => jsonResponse({ error: { code: "last_admin" } }, 409));

    await expect(operations.deleteAccount("pw")).rejects.toMatchObject({
      kind: "retryable",
      message: "last_admin",
    });
  });

  it("a network failure rejects as retryable", async () => {
    const operations = createAccountOperations({
      baseUrl: "/api",
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });

    await expect(operations.deleteAccount("pw")).rejects.toMatchObject({ kind: "retryable" });
  });
});
