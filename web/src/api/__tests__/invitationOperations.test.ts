import { describe, expect, it } from "vitest";
import { OperationError } from "../genericOperations.js";
import { createInvitationOperations } from "../invitationOperations.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const INPUT = { token: "invite-token", password: "correct horse battery staple" };

describe("invitation operations (issue #1088)", () => {
  it("posts the token and password as JSON with same-origin credentials and resolves to the created email", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const operations = createInvitationOperations({
      baseUrl: "/api",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), init });
        return jsonResponse({
          user: {
            id: "user-2",
            email: "invitee@example.com",
            locale: "en",
            createdAt: "2026-10-01T12:00:00.000Z",
            role: "member",
          },
        });
      },
    });

    const result = await operations.acceptInvitation(INPUT);

    expect(result).toEqual({ email: "invitee@example.com" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/invitations/accept");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.credentials).toBe("same-origin");
    expect((calls[0]!.init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual(INPUT);
  });

  it("rejects a 404 as unavailable with status 404", async () => {
    const operations = createInvitationOperations({
      baseUrl: "/api",
      fetchImpl: async () => jsonResponse({ error: "Not found" }, 404),
    });

    await expect(operations.acceptInvitation(INPUT)).rejects.toMatchObject({ kind: "unavailable", status: 404 });
  });

  it("rejects a 400 as retryable with the status and the body's error message", async () => {
    const operations = createInvitationOperations({
      baseUrl: "/api",
      fetchImpl: async () =>
        jsonResponse({ error: "'password' must be at least 8 characters", code: "validation_failed" }, 400),
    });

    await expect(operations.acceptInvitation({ token: "t", password: "short" })).rejects.toMatchObject({
      kind: "retryable",
      status: 400,
      message: "'password' must be at least 8 characters",
    });
  });

  it("rejects a throttled 429 as retryable with the status and the body's error message", async () => {
    const operations = createInvitationOperations({
      baseUrl: "/api",
      fetchImpl: async () => jsonResponse({ error: "Too many attempts; try again later", code: "rate_limited" }, 429),
    });

    await expect(operations.acceptInvitation(INPUT)).rejects.toMatchObject({
      kind: "retryable",
      status: 429,
      message: "Too many attempts; try again later",
    });
  });

  it("falls back to the default message when an error body has no string error", async () => {
    const operations = createInvitationOperations({
      baseUrl: "/api",
      fetchImpl: async () => new Response("<html>bad gateway</html>", { status: 502 }),
    });

    await expect(operations.acceptInvitation(INPUT)).rejects.toMatchObject({
      kind: "retryable",
      status: 502,
      message: "Request to /invitations/accept failed with 502",
    });
  });

  it("rejects a malformed success body as retryable", async () => {
    const operations = createInvitationOperations({
      baseUrl: "/api",
      fetchImpl: async () => jsonResponse({ user: { id: "user-2" } }),
    });

    await expect(operations.acceptInvitation(INPUT)).rejects.toMatchObject({ kind: "retryable" });
  });

  it("rejects a network failure as retryable", async () => {
    const operations = createInvitationOperations({
      baseUrl: "/api",
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });

    const rejection = operations.acceptInvitation(INPUT);
    await expect(rejection).rejects.toBeInstanceOf(OperationError);
    await expect(rejection).rejects.toMatchObject({ kind: "retryable", message: "Failed to fetch" });
  });
});
