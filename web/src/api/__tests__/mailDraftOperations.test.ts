import { describe, expect, it } from "vitest";
import { OperationError } from "../genericOperations.js";
import { createMailDraftOperations } from "../mailDraftOperations.js";

const DRAFT = {
  id: "d1",
  mailboxId: "m1",
  from: "me@example.com",
  to: [{ address: "ada@example.com", name: "Ada" }],
  cc: [],
  bcc: [],
  subject: "Hi",
  body: "Hello",
  threadId: null,
  mode: "new",
  sourceEmailId: null,
  attachments: [],
  createdBy: "user",
  lastEditedBy: "user",
  updatedAt: "2026-03-03T10:00:00.000Z",
  version: "7",
  sentAt: null,
};

const { attachments: _attachments, createdBy: _createdBy, lastEditedBy: _lastEditedBy, ...PARSED_DRAFT } = DRAFT;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface Call {
  url: string;
  method: string | undefined;
  credentials: RequestCredentials | undefined;
  body: unknown;
}

function recording(response: () => Response) {
  const calls: Call[] = [];
  const operations = createMailDraftOperations({
    baseUrl: "/api/",
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method,
        credentials: init?.credentials,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return response();
    },
  });
  return { operations, calls };
}

describe("mail draft operations: requests", () => {
  it("create posts the request to /mail/drafts and parses the draft it answers", async () => {
    const { operations, calls } = recording(() => jsonResponse(DRAFT, 201));

    const created = await operations.create({ mailboxId: "m1", mode: "reply", sourceEmailId: "e1", body: "" });

    expect(created).toEqual(PARSED_DRAFT);
    expect(calls).toEqual([
      {
        url: "/api/mail/drafts",
        method: "POST",
        credentials: "same-origin",
        body: { mailboxId: "m1", mode: "reply", sourceEmailId: "e1", body: "" },
      },
    ]);
  });

  it("update patches the draft with the version it was given and only the given fields", async () => {
    const { operations, calls } = recording(() => jsonResponse({ ...DRAFT, subject: "Hey", version: "8" }));

    const updated = await operations.update("d 1", "7", { subject: "Hey" });

    expect(updated.version).toBe("8");
    expect(calls[0]).toEqual({
      url: "/api/mail/drafts/d%201",
      method: "PATCH",
      credentials: "same-origin",
      body: { ifVersion: "7", subject: "Hey" },
    });
  });

  it("discard deletes the draft", async () => {
    const { operations, calls } = recording(() => jsonResponse({ id: "d1" }));

    await operations.discard("d1");

    expect(calls[0]).toMatchObject({ url: "/api/mail/drafts/d1", method: "DELETE", body: undefined });
  });

  it("send posts to the draft's send route and parses the sent message", async () => {
    const sent = {
      emailId: "d1",
      threadId: "t1",
      sentAt: "2026-03-03T11:00:00.000Z",
      mailbox: { id: "m1", name: "P" },
    };
    const { operations, calls } = recording(() => jsonResponse(sent));

    await expect(operations.send("d1")).resolves.toEqual(sent);
    expect(calls[0]).toMatchObject({ url: "/api/mail/drafts/d1/send", method: "POST", body: undefined });
  });
});

describe("mail draft operations: failures", () => {
  it("carries the backend's message on a conflict, as a retryable failure", async () => {
    const { operations } = recording(() =>
      jsonResponse(
        { error: { code: "version_conflict", message: "Draft was modified since ifVersion was read" } },
        409,
      ),
    );

    const failure = operations.update("d1", "6", { body: "x" });

    await expect(failure).rejects.toBeInstanceOf(OperationError);
    await expect(failure).rejects.toMatchObject({
      kind: "retryable",
      status: 409,
      message: "Draft was modified since ifVersion was read",
    });
  });

  it("classifies a refused From address as unavailable, with the backend's message", async () => {
    const { operations } = recording(() =>
      jsonResponse(
        {
          error: {
            code: "from_address_not_registered",
            message: "The from address is not a registered address of mailbox m1",
          },
        },
        403,
      ),
    );

    await expect(operations.update("d1", "7", { from: "x@example.com" })).rejects.toMatchObject({
      kind: "unavailable",
      status: 403,
      message: "The from address is not a registered address of mailbox m1",
    });
  });

  it("names the path and status when the failure body carries no message", async () => {
    const { operations } = recording(() => new Response("Bad gateway", { status: 502 }));

    await expect(operations.send("d1")).rejects.toMatchObject({
      kind: "retryable",
      status: 502,
      message: "Request to /mail/drafts/d1/send failed with 502",
    });
  });

  it("treats a network failure as retryable", async () => {
    const operations = createMailDraftOperations({
      baseUrl: "/api",
      fetchImpl: async () => Promise.reject(new TypeError("Failed to fetch")),
    });

    await expect(operations.discard("d1")).rejects.toMatchObject({ kind: "retryable", message: "Failed to fetch" });
  });

  it("refuses a success body that is not a draft", async () => {
    const { operations } = recording(() => jsonResponse({ id: "d1" }, 201));

    await expect(
      operations.create({
        mailboxId: "m1",
        mode: "new",
        threadId: null,
        from: "me@example.com",
        to: [],
        cc: [],
        bcc: [],
        subject: "",
        body: "",
      }),
    ).rejects.toMatchObject({ kind: "retryable", message: "Unexpected response from /mail/drafts" });
  });
});
