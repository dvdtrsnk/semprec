import { describe, expect, it } from "vitest";
import { OperationError } from "../genericOperations.js";
import { createInvitationOperations } from "../invitationOperations.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("invitation operations (issue #1088)", () => {
  it("posts the token and password as JSON with same-origin credentials, and resolves to the created account's email", async () => {
    const calls: Array<{ url: string; method?: string; credentials?: string; body: unknown; headers: unknown }> = [];
    const operations = createInvitationOperations({
      baseUrl: "/api",
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method,
          credentials: init?.credentials,
          body: JSON.parse(String(init?.body)),
          headers: init?.headers,
        });
        return jsonResponse({
          user: {
            id: "user-2",
            email: "invitee@example.com",
            locale: "cs",
            createdAt: "2026-10-01T12:00:00.000Z",
            role: "member",
          },
        });
      },
    });

    const result = await operations.acceptInvitation({ token: "abc", password: "correct horse battery staple" });

    expect(calls[0]).toMatchObject({
      url: "/api/invitations/accept",
      method: "POST",
      credentials: "same-origin",
      body: { token: "abc", password: "correct horse battery staple" },
      headers: { "Content-Type": "application/json" },
    });
    expect(result).toEqual({ email: "invitee@example.com" });
  });

  it("classifies a 404 as unavailable, since every unusable token gets this same answer", async () => {
    const operations = createInvitationOperations({
      baseUrl: "/api",
      fetchImpl: async () => jsonResponse({ error: "Not found" }, 404),
    });

    await expect(operations.acceptInvitation({ token: "t", password: "password123" })).rejects.toMatchObject({
      kind: "unavailable",
      status: 404,
      message: "Not found",
    });
  });

  it("surfaces the server's validation message for a 400 as retryable", async () => {
    const operations = createInvitationOperations({
      baseUrl: "/api",
      fetchImpl: async () =>
        jsonResponse({ error: "password must be at least 8 characters", code: "validation_failed" }, 400),
    });

    await expect(operations.acceptInvitation({ token: "t", password: "short" })).rejects.toMatchObject({
      kind: "retryable",
      status: 400,
      message: "password must be at least 8 characters",
    });
  });

  it("surfaces the server's error string for a throttled 429 as retryable", async () => {
    const operations = createInvitationOperations({
      baseUrl: "/api",
      fetchImpl: async () => jsonResponse({ error: "Too many requests", code: "rate_limited" }, 429),
    });

    await expect(operations.acceptInvitation({ token: "t", password: "password123" })).rejects.toMatchObject({
      kind: "retryable",
      status: 429,
      message: "Too many requests",
    });
  });

  it("falls back to the status-based message when a 400's error body does not match the expected shape", async () => {
    const operations = createInvitationOperations({
      baseUrl: "/api",
      fetchImpl: async () => jsonResponse({ error: 12345 }, 400),
    });

    await expect(operations.acceptInvitation({ token: "t", password: "short" })).rejects.toMatchObject({
      kind: "retryable",
      status: 400,
      message: "Request to /invitations/accept failed with 400",
    });
  });

  it("falls back to the status-based message when a 500's body is not JSON", async () => {
    const operations = createInvitationOperations({
      baseUrl: "/api",
      fetchImpl: async () => new Response("<html>Internal error</html>", { status: 500 }),
    });

    await expect(operations.acceptInvitation({ token: "t", password: "password123" })).rejects.toMatchObject({
      kind: "retryable",
      status: 500,
      message: "Request to /invitations/accept failed with 500",
    });
  });

  it("classifies a malformed success envelope as retryable instead of throwing an unhandled error", async () => {
    const operations = createInvitationOperations({
      baseUrl: "/api",
      fetchImpl: async () => jsonResponse({ user: { id: "user-2" } }),
    });

    await expect(operations.acceptInvitation({ token: "t", password: "password123" })).rejects.toMatchObject({
      kind: "retryable",
    });
  });

  it("classifies a success response whose body is not JSON as retryable", async () => {
    const operations = createInvitationOperations({
      baseUrl: "/api",
      fetchImpl: async () => new Response("not json", { status: 200 }),
    });

    await expect(operations.acceptInvitation({ token: "t", password: "password123" })).rejects.toMatchObject({
      kind: "retryable",
    });
  });

  it("classifies a transport failure as a retryable OperationError", async () => {
    const operations = createInvitationOperations({
      baseUrl: "/api",
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });

    const failure = await operations
      .acceptInvitation({ token: "t", password: "password123" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OperationError);
    expect(failure).toMatchObject({ kind: "retryable", message: "Failed to fetch" });
  });
});
