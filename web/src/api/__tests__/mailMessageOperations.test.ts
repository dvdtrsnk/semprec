import { describe, expect, it } from "vitest";
import { OperationError } from "../genericOperations.js";
import {
  MAIL_CONTENT_UNAVAILABLE_REASONS,
  MailMessageError,
  createMailMessageOperations,
} from "../mailMessageOperations.js";

const CONTENT = {
  emailId: "e1",
  contentState: "cached",
  bodyHtml: "<p>Hello</p>",
  bodyText: "Hello",
  fetchedAt: "2026-11-20T10:00:00.000Z",
  expiresAt: "2026-11-27T10:00:00.000Z",
  attachments: [
    {
      attachmentId: "a1",
      filename: "report.pdf",
      contentType: "application/pdf",
      byteSize: 2048,
      stored: false,
      blobId: null,
      fileItemId: null,
    },
  ],
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

interface Call {
  url: string;
  method: string | undefined;
  credentials: RequestCredentials | undefined;
}

function recording(response: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const operations = createMailMessageOperations({
    baseUrl: "/api/",
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), method: init?.method, credentials: init?.credentials });
      return response();
    },
  });
  return { operations, calls };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("Expected a rejection");
    },
    (error: unknown) => error,
  );
}

describe("mail message operations: requests", () => {
  it("getContent reads the message's content route and parses its body and attachments", async () => {
    const { operations, calls } = recording(() => jsonResponse(CONTENT));

    expect(await operations.getContent("e1")).toEqual(CONTENT);
    expect(calls).toEqual([{ url: "/api/mail/messages/e1/content", method: "GET", credentials: "same-origin" }]);
  });

  it("saveAttachment posts to the attachment's save route and parses the Files item id", async () => {
    const { operations, calls } = recording(() => jsonResponse({ fileItemId: "f1" }));

    expect(await operations.saveAttachment("e 1", "a/1")).toEqual({ fileItemId: "f1" });
    expect(calls).toEqual([
      { url: "/api/mail/messages/e%201/attachments/a%2F1/save", method: "POST", credentials: "same-origin" },
    ]);
  });

  it("blobUrl points at the blob route under the same base", () => {
    expect(recording(() => jsonResponse({})).operations.blobUrl("b1")).toBe("/api/blobs/b1");
  });
});

describe("mail message operations: answers it refuses", () => {
  it.each([
    {
      name: "an attachment without its size",
      body: { ...CONTENT, attachments: [{ ...CONTENT.attachments[0], byteSize: undefined }] },
    },
    { name: "a content state the route does not answer", body: { ...CONTENT, contentState: "remote" } },
    { name: "a body that is not JSON", body: undefined },
  ])("reports $name as an unexpected, retryable response", async ({ body }) => {
    const { operations } = recording(() =>
      body === undefined ? new Response("<html>", { status: 200 }) : jsonResponse(body),
    );

    const error = await rejection(operations.getContent("e1"));

    expect(error).toBeInstanceOf(OperationError);
    expect(error).not.toBeInstanceOf(MailMessageError);
    expect(error).toMatchObject({ kind: "retryable", message: "Unexpected response from /mail/messages/e1/content" });
  });
});

describe("mail message operations: refusals", () => {
  it.each(
    MAIL_CONTENT_UNAVAILABLE_REASONS.map((reason) => ({
      reason,
      kind: reason === "providerUnreachable" ? "retryable" : "unavailable",
    })),
  )("maps 409 mail_content_unavailable with reason $reason to a typed $kind failure", async ({ reason, kind }) => {
    const { operations } = recording(() =>
      jsonResponse({ error: { code: "mail_content_unavailable", details: { reason } } }, 409),
    );

    const error = await rejection(operations.getContent("e1"));

    expect(error).toBeInstanceOf(MailMessageError);
    expect(error).toMatchObject({ kind, status: 409, failure: { code: "contentUnavailable", reason } });
  });

  it.each<{ name: string; headers: Record<string, string>; retryAfterSeconds: number | null }>([
    { name: "with Retry-After in seconds", headers: { "Retry-After": "42" }, retryAfterSeconds: 42 },
    { name: "without Retry-After", headers: {}, retryAfterSeconds: null },
    {
      name: "with Retry-After as a date",
      headers: { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" },
      retryAfterSeconds: null,
    },
  ])("maps 429 $name to a retryable rate-limit failure", async ({ headers, retryAfterSeconds }) => {
    const { operations } = recording(() => jsonResponse({ error: { code: "rate_limited" } }, 429, headers));

    const error = await rejection(operations.saveAttachment("e1", "a1"));

    expect(error).toBeInstanceOf(MailMessageError);
    expect(error).toMatchObject({
      kind: "retryable",
      status: 429,
      failure: { code: "rateLimited", retryAfterSeconds },
    });
  });

  it("maps 404 to a typed, unavailable not-found failure", async () => {
    const { operations } = recording(() => jsonResponse({ error: { code: "not_found" } }, 404));

    const error = await rejection(operations.getContent("e1"));

    expect(error).toBeInstanceOf(MailMessageError);
    expect(error).toMatchObject({ kind: "unavailable", status: 404, failure: { code: "notFound" } });
  });

  it.each([
    {
      name: "a 409 with another code",
      status: 409,
      body: { error: { code: "transaction_conflict" } },
      kind: "retryable",
    },
    {
      name: "a 409 with a reason this client does not know",
      status: 409,
      body: { error: { code: "mail_content_unavailable", details: { reason: "somethingNew" } } },
      kind: "retryable",
    },
    { name: "a 500 without a JSON body", status: 500, body: undefined, kind: "retryable" },
    { name: "a 403", status: 403, body: { error: { code: "forbidden" } }, kind: "unavailable" },
  ])("keeps $name a generic failure with its status", async ({ status, body, kind }) => {
    const { operations } = recording(() =>
      body === undefined ? new Response("oops", { status }) : jsonResponse(body, status),
    );

    const error = await rejection(operations.getContent("e1"));

    expect(error).toBeInstanceOf(OperationError);
    expect(error).not.toBeInstanceOf(MailMessageError);
    expect(error).toMatchObject({ kind, status });
  });

  it("reports a request that never reached the server as retryable, without a status", async () => {
    const { operations } = recording(() => Promise.reject(new TypeError("Failed to fetch")));

    const error = await rejection(operations.getContent("e1"));

    expect(error).toBeInstanceOf(OperationError);
    expect(error).toMatchObject({ kind: "retryable", status: undefined, message: "Failed to fetch" });
  });
});
