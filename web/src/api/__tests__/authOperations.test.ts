import { describe, expect, it, vi } from "vitest";
import { OperationError } from "../genericOperations.js";
import { createAuthOperations } from "../authOperations.js";

const USER = {
  id: "user-1",
  email: "operator@example.com",
  locale: "en",
  createdAt: "2026-09-01T12:00:00.000Z",
  role: "member",
};

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
    expect(calls).toHaveLength(2);
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

  it("login resolves the user through the session read, since the login body carries no role", async () => {
    const calls: string[] = [];
    const auth = createAuthOperations({
      baseUrl: "/api",
      fetchImpl: async (input) => {
        calls.push(String(input));
        if (String(input).endsWith("/auth/login")) return jsonResponse({ user: { id: "user-1" } });
        return jsonResponse({ user: { ...USER, role: "admin" } });
      },
    });

    await expect(auth.login({ email: "operator@example.com", password: "x" })).resolves.toEqual({
      ...USER,
      role: "admin",
    });
    expect(calls).toEqual(["/api/auth/login", "/api/auth/session"]);
  });

  it("login rejects as retryable when the session read after a successful login finds no session", async () => {
    const auth = createAuthOperations({
      baseUrl: "/api",
      fetchImpl: async (input) =>
        String(input).endsWith("/auth/login")
          ? jsonResponse({ user: USER })
          : jsonResponse({ error: "Invalid or missing credentials" }, 401),
    });

    await expect(auth.login({ email: "operator@example.com", password: "x" })).rejects.toMatchObject({
      kind: "retryable",
    });
  });

  it.each(["admin", "member"])("getSession parses a session role of %s", async (role) => {
    const auth = authWith(() => jsonResponse({ user: { ...USER, role } }));

    await expect(auth.getSession()).resolves.toEqual({ ...USER, role });
  });

  it.each([undefined, "owner"])("getSession rejects a session role of %s as retryable", async (role) => {
    const user = role === undefined ? { id: USER.id, email: USER.email, locale: USER.locale, createdAt: USER.createdAt } : { ...USER, role };
    const auth = authWith(() => jsonResponse({ user }));

    await expect(auth.getSession()).rejects.toMatchObject({ kind: "retryable" });
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

describe("password-reset operations", () => {
  it("requestPasswordReset posts the email as JSON with same-origin credentials and resolves on 200", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const auth = createAuthOperations({
      baseUrl: "/api",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), init });
        return jsonResponse({ ok: true });
      },
    });

    await expect(auth.requestPasswordReset("operator@example.com")).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/auth/password-reset/request");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.credentials).toBe("same-origin");
    expect(calls[0]!.init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ email: "operator@example.com" });
  });

  it.each([429, 500])(
    "requestPasswordReset rejects a %i as retryable with the status and the server's message",
    async (status) => {
      const auth = authWith(() => jsonResponse({ error: "Too many requests" }, status));

      await expect(auth.requestPasswordReset("a@example.com")).rejects.toMatchObject({
        kind: "retryable",
        status,
        message: "Too many requests",
      });
    },
  );

  it("requestPasswordReset reports a transport failure as retryable", async () => {
    const auth = createAuthOperations({
      baseUrl: "/api",
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });

    await expect(auth.requestPasswordReset("a@example.com")).rejects.toMatchObject({
      kind: "retryable",
      message: "Failed to fetch",
    });
  });

  it("resetPassword posts the token and new password as JSON and resolves on 200", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const auth = createAuthOperations({
      baseUrl: "/api",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), init });
        return jsonResponse({ ok: true });
      },
    });

    await expect(auth.resetPassword({ token: "abc", newPassword: "a new password" })).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/auth/password-reset/consume");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.credentials).toBe("same-origin");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ token: "abc", newPassword: "a new password" });
  });

  it.each(["password_reset_token_invalid", "password_reset_token_expired", "password_reset_token_consumed"])(
    "resetPassword rejects a 400 with code %s as unavailable",
    async (code) => {
      const auth = authWith(() => jsonResponse({ error: "Reset link is not valid", code }, 400));

      await expect(auth.resetPassword({ token: "abc", newPassword: "a new password" })).rejects.toMatchObject({
        kind: "unavailable",
        status: 400,
        message: "Reset link is not valid",
      });
    },
  );

  it("resetPassword rejects a 400 validation_failed as retryable with the server's message", async () => {
    const auth = authWith(() =>
      jsonResponse({ error: "password must be at least 8 characters", code: "validation_failed" }, 400),
    );

    await expect(auth.resetPassword({ token: "abc", newPassword: "short" })).rejects.toMatchObject({
      kind: "retryable",
      status: 400,
      message: "password must be at least 8 characters",
    });
  });

  it("resetPassword rejects a non-JSON 500 as retryable with the generic message", async () => {
    const auth = authWith(() => new Response("oops", { status: 500 }));

    await expect(auth.resetPassword({ token: "abc", newPassword: "a new password" })).rejects.toMatchObject({
      kind: "retryable",
      status: 500,
      message: "Request to /auth/password-reset/consume failed with 500",
    });
  });

  it.each([400, 413, 500])(
    "resetPassword preserves an error-only %i response and reads its body once",
    async (status) => {
      const response = jsonResponse({ error: "Reset request failed" }, status);
      const readJson = vi.spyOn(response, "json");
      const auth = authWith(() => response);

      await expect(auth.resetPassword({ token: "abc", newPassword: "a new password" })).rejects.toMatchObject({
        kind: "retryable",
        status,
        message: "Reset request failed",
      });
      expect(readJson).toHaveBeenCalledTimes(1);
    },
  );

  it("resetPassword preserves the error message when the code has an unexpected type", async () => {
    const auth = authWith(() => jsonResponse({ error: "Reset request failed", code: 123 }, 400));

    await expect(auth.resetPassword({ token: "abc", newPassword: "a new password" })).rejects.toMatchObject({
      kind: "retryable",
      status: 400,
      message: "Reset request failed",
    });
  });

  it("resetPassword reports a transport failure as retryable", async () => {
    const auth = createAuthOperations({
      baseUrl: "/api",
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });

    await expect(auth.resetPassword({ token: "abc", newPassword: "a new password" })).rejects.toMatchObject({
      kind: "retryable",
      message: "Failed to fetch",
    });
  });
});
