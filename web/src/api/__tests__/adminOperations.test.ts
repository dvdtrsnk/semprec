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
  it.each([401, 403, 404, 501])("rejects a %i as unavailable", async (status) => {
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

  it("rejects a malformed success body as retryable, with a fixed message that names the path", async () => {
    const operations = failingWith(() => jsonResponse({ accounts: [{ userId: 1 }] }));

    await expect(operations.listAccounts()).rejects.toMatchObject({
      kind: "retryable",
      message: "Unexpected response from /admin/accounts",
    });
  });

  it("rejects a success body that is not JSON with the same fixed message", async () => {
    const operations = failingWith(() => new Response("<html>", { status: 200 }));

    await expect(operations.listAccounts()).rejects.toMatchObject({
      kind: "retryable",
      message: "Unexpected response from /admin/accounts",
    });
  });

  it("does not read a failure body past the size cap, and falls back to the status message", async () => {
    let pulls = 0;
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
    });
    const operations = createAdminOperations({
      baseUrl: "/api",
      fetchImpl: async () => new Response(body, { status: 500 }),
    });

    await expect(operations.listAccounts()).rejects.toMatchObject({
      kind: "retryable",
      status: 500,
      message: "Request to /admin/accounts failed with 500",
    });
    expect(pulls).toBeLessThanOrEqual(2);
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

const INVITE = {
  id: "i1",
  email: "a@example.com",
  invitedBy: "user-1",
  createdAt: "2026-10-01T09:00:00.000Z",
  expiresAt: "2026-10-08T09:00:00.000Z",
  acceptedAt: null,
  revokedAt: null,
  status: "pending",
};

describe("admin operations: invitations", () => {
  it("listInvites gets the invitation list with same-origin credentials and parses it", async () => {
    const { operations, calls } = recording(() => jsonResponse({ invites: [INVITE] }));

    await expect(operations.listInvites()).resolves.toEqual([INVITE]);
    expect(calls[0]!.url).toBe("/api/admin/invites");
    expect(calls[0]!.init).toMatchObject({ credentials: "same-origin" });
    expect(calls[0]!.init?.method).toBeUndefined();
  });

  it("createInvite posts the email as JSON and parses the invite, its link and the emailed flag", async () => {
    const created = { invite: INVITE, inviteUrl: "https://example.com/?page=invite#token=abc", emailed: true };
    const { operations, calls } = recording(() => jsonResponse(created, 201));

    await expect(operations.createInvite("a@example.com")).resolves.toEqual(created);
    expect(calls[0]!.url).toBe("/api/admin/invites");
    expect(calls[0]!.init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ email: "a@example.com" });
  });

  it("revokeInvite posts to the encoded revoke route and parses the invite", async () => {
    const { operations, calls } = recording(() => jsonResponse({ invite: { ...INVITE, status: "revoked" } }));

    await expect(operations.revokeInvite("i 1")).resolves.toEqual({ ...INVITE, status: "revoked" });
    expect(calls[0]!.url).toBe("/api/admin/invites/i%201/revoke");
    expect(calls[0]!.init).toMatchObject({ method: "POST", credentials: "same-origin" });
  });

  it("createInvite rejects a 400 validation_failed as retryable with the code as its message", async () => {
    const operations = failingWith(() => jsonResponse({ error: { code: "validation_failed" } }, 400));

    await expect(operations.createInvite("taken@example.com")).rejects.toMatchObject({
      kind: "retryable",
      status: 400,
      message: "validation_failed",
    });
  });

  it("revokeInvite rejects a 409 invite_not_pending as retryable with the code as its message", async () => {
    const operations = failingWith(() => jsonResponse({ error: { code: "invite_not_pending" } }, 409));

    await expect(operations.revokeInvite("i1")).rejects.toMatchObject({
      kind: "retryable",
      status: 409,
      message: "invite_not_pending",
    });
  });

  it("rejects a malformed invitation list as retryable", async () => {
    const operations = failingWith(() => jsonResponse({ invites: [{ id: 1 }] }));

    await expect(operations.listInvites()).rejects.toMatchObject({
      kind: "retryable",
      message: "Unexpected response from /admin/invites",
    });
  });

  it("rejects a malformed revoke response as retryable", async () => {
    const operations = failingWith(() => jsonResponse({ invite: { ...INVITE, status: "gone" } }));

    await expect(operations.revokeInvite("i 1")).rejects.toMatchObject({
      kind: "retryable",
      message: "Unexpected response from /admin/invites/i%201/revoke",
    });
  });

  it("rejects a malformed create response as retryable", async () => {
    const operations = failingWith(() => jsonResponse({ invite: INVITE, inviteUrl: "x" }, 201));

    await expect(operations.createInvite("a@example.com")).rejects.toMatchObject({
      kind: "retryable",
      message: "Unexpected response from /admin/invites",
    });
  });
});

const BUDGET_ACCOUNT = {
  userId: "user-2",
  email: "member@example.com",
  hasBudget: true,
  dailyCapUsd: 2,
  monthlyCapUsd: null,
  spentTodayUsd: 0.5,
  spentMonthUsd: 3.25,
};

describe("admin operations: AI budgets", () => {
  it("listAiBudgets gets the budget list with same-origin credentials and parses it", async () => {
    const { operations, calls } = recording(() => jsonResponse({ spendWindow: "utc", accounts: [BUDGET_ACCOUNT] }));

    await expect(operations.listAiBudgets()).resolves.toEqual([BUDGET_ACCOUNT]);
    expect(calls[0]!.url).toBe("/api/admin/ai-budgets");
    expect(calls[0]!.init).toMatchObject({ credentials: "same-origin" });
    expect(calls[0]!.init?.method).toBeUndefined();
  });

  it("setAiBudget puts both caps as JSON to the encoded budget route", async () => {
    const { operations, calls } = recording(() =>
      jsonResponse({
        budget: { userId: "u 1", dailyCapUsd: 2, monthlyCapUsd: null, updatedAt: "2026-10-18T09:00:00.000Z" },
      }),
    );

    await expect(operations.setAiBudget("u 1", { dailyCapUsd: 2, monthlyCapUsd: null })).resolves.toBeUndefined();
    expect(calls[0]!.url).toBe("/api/admin/accounts/u%201/ai-budget");
    expect(calls[0]!.init).toMatchObject({ method: "PUT", credentials: "same-origin" });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ dailyCapUsd: 2, monthlyCapUsd: null });
  });

  it("setAiBudget rejects a 400 validation_failed as retryable with the code as its message", async () => {
    const operations = failingWith(() => jsonResponse({ error: { code: "validation_failed" } }, 400));

    await expect(operations.setAiBudget("user-2", { dailyCapUsd: -1, monthlyCapUsd: null })).rejects.toMatchObject({
      kind: "retryable",
      status: 400,
      message: "validation_failed",
    });
  });

  it("setAiBudget rejects a 403 as unavailable", async () => {
    const operations = failingWith(() => jsonResponse({ error: { code: "admin_required" } }, 403));

    await expect(operations.setAiBudget("user-2", { dailyCapUsd: 1, monthlyCapUsd: 2 })).rejects.toMatchObject({
      kind: "unavailable",
      status: 403,
    });
  });

  it("setAiBudget rejects a malformed budget response as retryable", async () => {
    const operations = failingWith(() => jsonResponse({ budget: { userId: "user-2" } }));

    await expect(operations.setAiBudget("user-2", { dailyCapUsd: 1, monthlyCapUsd: null })).rejects.toMatchObject({
      kind: "retryable",
      message: "Unexpected response from /admin/accounts/user-2/ai-budget",
    });
  });

  it("listAiBudgets rejects a 403 as unavailable", async () => {
    const operations = failingWith(() => jsonResponse({ error: { code: "admin_required" } }, 403));

    await expect(operations.listAiBudgets()).rejects.toMatchObject({ kind: "unavailable", status: 403 });
  });

  it("rejects a malformed budget list as retryable", async () => {
    const operations = failingWith(() => jsonResponse({ spendWindow: "local", accounts: [] }));

    await expect(operations.listAiBudgets()).rejects.toMatchObject({
      kind: "retryable",
      message: "Unexpected response from /admin/ai-budgets",
    });
  });
});
