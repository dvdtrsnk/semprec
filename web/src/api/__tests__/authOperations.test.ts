import { describe, expect, it } from "vitest";
import { OperationError } from "../genericOperations.js";
import { createAuthOperations } from "../authOperations.js";

const USER = { id: "user-1", email: "operator@example.com", locale: "en", createdAt: "2026-09-01T12:00:00.000Z" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function authWith(response: () => Response) {
  return createAuthOperations({ baseUrl: "/api", fetchImpl: async () => response() });
}

describe("auth operations", () => {
  it("login posts email, password and platform web with same-origin credentials, and parses the user", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const auth = createAuthOperations({
      baseUrl: "/api/",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), init });
        return jsonResponse({ user: USER });
      },
    });

    const user = await auth.login({ email: "operator@example.com", password: "correct horse" });

    expect(user).toEqual(USER);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/auth/login");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.credentials).toBe("same-origin");
    expect(calls[0]!.init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      email: "operator@example.com",
      password: "correct horse",
      platform: "web",
    });
  });

  it("login maps a 401 to an OperationError carrying status 401 and the server's message", async () => {
    const auth = authWith(() => jsonResponse({ error: "Invalid or missing credentials", code: "unauthorized" }, 401));

    const failure = await auth.login({ email: "a@example.com", password: "wrong" }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OperationError);
    expect(failure).toMatchObject({ kind: "unavailable", status: 401, message: "Invalid or missing credentials" });
  });

  it("login surfaces the server's error string for a 400 as retryable", async () => {
    const auth = authWith(() => jsonResponse({ error: "email must be a string", code: "validation_failed" }, 400));

    await expect(auth.login({ email: "a@example.com", password: "x" })).rejects.toMatchObject({
      kind: "retryable",
      status: 400,
      message: "email must be a string",
    });
  });

  it("login reports a transport failure and an unparseable body as retryable", async () => {
    const offline = createAuthOperations({
      baseUrl: "/api",
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await expect(offline.login({ email: "a@example.com", password: "x" })).rejects.toMatchObject({
      kind: "retryable",
      message: "Failed to fetch",
    });

    const malformed = authWith(() => jsonResponse({ user: { id: 1 } }));
    await expect(malformed.login({ email: "a@example.com", password: "x" })).rejects.toMatchObject({
      kind: "retryable",
    });
  });

  it("getSession resolves the user on 200", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const auth = createAuthOperations({
      baseUrl: "/api",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), init });
        return jsonResponse({ user: USER, session: { id: "session-1", platform: "web" } });
      },
    });

    await expect(auth.getSession()).resolves.toEqual(USER);
    expect(calls[0]).toMatchObject({ url: "/api/auth/session", init: { method: "GET", credentials: "same-origin" } });
  });

  it("getSession resolves null on 401", async () => {
    const auth = authWith(() => jsonResponse({ error: "Invalid or missing credentials", code: "unauthorized" }, 401));

    await expect(auth.getSession()).resolves.toBeNull();
  });

  it("getSession rejects a 500 as retryable", async () => {
    const auth = authWith(() => jsonResponse({ error: "boom" }, 500));

    await expect(auth.getSession()).rejects.toMatchObject({ kind: "retryable", status: 500, message: "boom" });
  });

  it("logout posts to /auth/logout and resolves on 200", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const auth = createAuthOperations({
      baseUrl: "/api",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), init });
        return jsonResponse({ ok: true });
      },
    });

    await expect(auth.logout()).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ url: "/api/auth/logout", init: { method: "POST", credentials: "same-origin" } });
  });

  it("logout resolves on 401, since a session that is already gone is logged out", async () => {
    const auth = authWith(() => jsonResponse({ error: "Invalid or missing credentials" }, 401));

    await expect(auth.logout()).resolves.toBeUndefined();
  });

  it("logout rejects a 500 as retryable", async () => {
    const auth = authWith(() => new Response("oops", { status: 500 }));

    await expect(auth.logout()).rejects.toMatchObject({
      kind: "retryable",
      status: 500,
      message: "Request to /auth/logout failed with 500",
    });
  });
});
