import { describe, expect, it } from "vitest";
import { OperationError } from "../genericOperations.js";
import { createAdminOperations } from "../adminOperations.js";

const ACCOUNT = {
  userId: "user-2",
  email: "member@example.com",
  role: "member",
  status: "active",
  createdAt: "2026-09-01T12:00:00.000Z",
  lastSeenAt: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function recording(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const operations = createAdminOperations({
    baseUrl: "/api/",
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return response();
    },
  });
  return { operations, calls };
}

function failingWith(response: () => Response) {
  return createAdminOperations({ baseUrl: "/api", fetchImpl: async () => response() });
}

describe("admin operations: calls", () => {
  it("listAccounts gets the account list with same-origin credentials and parses it", async () => {
    const { operations, calls } = recording(() => jsonResponse({ accounts: [ACCOUNT] }));

    await expect(operations.listAccounts()).resolves.toEqual([ACCOUNT]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/admin/accounts");
    expect(calls[0]!.init).toMatchObject({ credentials: "same-origin" });
    expect(calls[0]!.init?.method).toBeUndefined();
  });

  it.each([
    ["suspendAccount", "suspend"],
    ["reactivateAccount", "reactivate"],
  ] as const)("%s posts to the %s route and parses the account", async (method, action) => {
    const { operations, calls } = recording(() => jsonResponse({ account: { ...ACCOUNT, status: "suspended" } }));

    await expect(operations[method]("user-2")).resolves.toEqual({ ...ACCOUNT, status: "suspended" });
    expect(calls[0]!.url).toBe(`/api/admin/accounts/user-2/${action}`);
    expect(calls[0]!.init).toMatchObject({ method: "POST", credentials: "same-origin" });
  });

  it("changeRole puts the role as JSON to the role route and parses the account", async () => {
    const { operations, calls } = recording(() => jsonResponse({ account: { ...ACCOUNT, role: "admin" } }));

    await expect(operations.changeRole("user-2", "admin")).resolves.toEqual({ ...ACCOUNT, role: "admin" });
    expect(calls[0]!.url).toBe("/api/admin/accounts/user-2/role");
    expect(calls[0]!.init).toMatchObject({ method: "PUT", credentials: "same-origin" });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ role: "admin" });
  });

  it("encodes the user id in the path", async () => {
    const { operations, calls } = recording(() => jsonResponse({ account: ACCOUNT }));

    await operations.suspendAccount("a/b c");
    expect(calls[0]!.url).toBe("/api/admin/accounts/a%2Fb%20c/suspend");
  });
});

describe("admin operations: rejections", () => {
  it.each([403, 404])("rejects a %i as unavailable", async (status) => {
    const operations = failingWith(() => jsonResponse({ error: { code: "admin_required" } }, status));

    const failure = await operations.listAccounts().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OperationError);
    expect(failure).toMatchObject({ kind: "unavailable", status });
  });

  it("rejects a 409 last_admin as retryable with the code as its message", async () => {
    const operations = failingWith(() => jsonResponse({ error: { code: "last_admin" } }, 409));

    await expect(operations.changeRole("user-2", "member")).rejects.toMatchObject({
      kind: "retryable",
      status: 409,
      message: "last_admin",
    });
  });

  it("names the path and status when a failure body carries no code", async () => {
    const operations = failingWith(() => new Response("oops", { status: 500 }));

    await expect(operations.listAccounts()).rejects.toMatchObject({
      kind: "retryable",
      status: 500,
      message: "Request to /admin/accounts failed with 500",
    });
  });

  it("rejects a malformed success body as retryable", async () => {
    const operations = failingWith(() => jsonResponse({ accounts: [{ userId: 1 }] }));

    await expect(operations.listAccounts()).rejects.toMatchObject({ kind: "retryable" });
  });

  it("rejects a transport failure as retryable", async () => {
    const operations = createAdminOperations({
      baseUrl: "/api",
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });

    await expect(operations.suspendAccount("user-2")).rejects.toMatchObject({
      kind: "retryable",
      message: "Failed to fetch",
    });
  });
});
