import { describe, expect, it } from "vitest";
import { OperationError } from "../genericOperations.js";
import { createSetupOperations } from "../setupOperations.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("setup operations", () => {
  it("posts email, password, and the token as a bearer header, and parses the created user", async () => {
    const calls: Array<{ url: string; method?: string; body: unknown; authorization: string | null }> = [];
    const operations = createSetupOperations({
      baseUrl: "/api",
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method,
          body: JSON.parse(String(init?.body)),
          authorization: (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? null,
        });
        return jsonResponse({
          user: { id: "user-1", email: "operator@example.com", locale: "en", createdAt: "2026-09-01T12:00:00.000Z" },
        });
      },
    });

    const user = await operations.setupAccount({
      token: "bootstrap-token",
      email: "operator@example.com",
      password: "correct horse battery staple",
    });

    expect(calls[0]).toMatchObject({
      url: "/api/setup",
      method: "POST",
      body: { email: "operator@example.com", password: "correct horse battery staple" },
      authorization: "Bearer bootstrap-token",
    });
    expect(user).toEqual({
      id: "user-1",
      email: "operator@example.com",
      locale: "en",
      createdAt: "2026-09-01T12:00:00.000Z",
    });
  });

  it("classifies a 404 as unavailable, per #233 not distinguishing an exhausted setup from a wrong token", async () => {
    const operations = createSetupOperations({
      baseUrl: "/api",
      fetchImpl: async () => jsonResponse({ error: "Not found" }, 404),
    });

    await expect(
      operations.setupAccount({ token: "t", email: "a@example.com", password: "password123" }),
    ).rejects.toMatchObject({ kind: "unavailable", status: 404 });
  });

  it("surfaces the server's validation message for a 400", async () => {
    const operations = createSetupOperations({
      baseUrl: "/api",
      fetchImpl: async () => jsonResponse({ error: "'password' must be at least 8 characters" }, 400),
    });

    await expect(
      operations.setupAccount({ token: "t", email: "a@example.com", password: "short" }),
    ).rejects.toMatchObject({ kind: "retryable", status: 400, message: "'password' must be at least 8 characters" });
  });

  it("falls back to the default message when a 400's error body doesn't match the expected shape", async () => {
    const operations = createSetupOperations({
      baseUrl: "/api",
      fetchImpl: async () => jsonResponse({ error: 12345 }, 400),
    });

    await expect(
      operations.setupAccount({ token: "t", email: "a@example.com", password: "short" }),
    ).rejects.toMatchObject({ kind: "retryable", status: 400, message: "Request to /setup failed with 400" });
  });

  it("classifies a malformed success envelope (e.g. a bare null body) as retryable instead of throwing an unhandled TypeError", async () => {
    const operations = createSetupOperations({
      baseUrl: "/api",
      fetchImpl: async () => jsonResponse(null),
    });

    await expect(
      operations.setupAccount({ token: "t", email: "a@example.com", password: "password123" }),
    ).rejects.toMatchObject({ kind: "retryable" });
  });

  it("classifies a transport failure as retryable", async () => {
    const operations = createSetupOperations({
      baseUrl: "/api",
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });

    await expect(
      operations.setupAccount({ token: "t", email: "a@example.com", password: "password123" }),
    ).rejects.toBeInstanceOf(OperationError);
  });
});
