import { describe, expect, it } from "vitest";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import {
  appendClientUpdateId,
  buildBinaryFrame,
  decodeDocId,
  encodeDocId,
  isClientUpdateId,
  parseBinaryFrame,
  parseInboundFrame,
  readClientUpdateId,
} from "../protocolV1.js";
import {
  parseAgentStreamEnvelope,
  parseAgentStreamMessage,
  parseRealtimeEnvelope,
  parseRealtimeMessage,
} from "../pgNotifyPublisher.js";

const DOC_ID = "11111111-1111-1111-1111-111111111111";
const RUN_ID = "22222222-2222-2222-2222-222222222222";

describe("parseInboundFrame (issue #160)", () => {
  it("accepts a well-formed doc:open frame", () => {
    expect(parseInboundFrame(JSON.stringify({ type: "doc:open", docId: DOC_ID }))).toEqual({
      type: "doc:open",
      docId: DOC_ID,
    });
  });

  it("accepts a well-formed doc:close frame", () => {
    expect(parseInboundFrame(JSON.stringify({ type: "doc:close", docId: DOC_ID }))).toEqual({
      type: "doc:close",
      docId: DOC_ID,
    });
  });

  it("accepts a well-formed agent:watch frame", () => {
    expect(parseInboundFrame(JSON.stringify({ type: "agent:watch", runId: RUN_ID, afterEventId: "42" }))).toEqual({
      type: "agent:watch",
      runId: RUN_ID,
      afterEventId: "42",
    });
  });

  it("accepts a well-formed agent:unwatch frame", () => {
    expect(parseInboundFrame(JSON.stringify({ type: "agent:unwatch", runId: RUN_ID }))).toEqual({
      type: "agent:unwatch",
      runId: RUN_ID,
    });
  });

  it("rejects non-JSON input", () => {
    expect(parseInboundFrame("not json")).toBeNull();
  });

  it("rejects a JSON array", () => {
    expect(parseInboundFrame("[1,2,3]")).toBeNull();
  });

  it("rejects an unknown frame type", () => {
    expect(parseInboundFrame(JSON.stringify({ type: "doc:delete", docId: DOC_ID }))).toBeNull();
  });

  it("rejects a doc:open frame with a non-UUID docId", () => {
    expect(parseInboundFrame(JSON.stringify({ type: "doc:open", docId: "not-a-uuid" }))).toBeNull();
  });

  it("rejects a doc:open frame missing docId", () => {
    expect(parseInboundFrame(JSON.stringify({ type: "doc:open" }))).toBeNull();
  });

  it("rejects an agent:watch frame with a non-UUID agentRunId", () => {
    expect(parseInboundFrame(JSON.stringify({ type: "agent:watch", runId: 123, afterEventId: "0" }))).toBeNull();
  });

  it("rejects an agent:watch frame without a bigint-safe cursor", () => {
    expect(parseInboundFrame(JSON.stringify({ type: "agent:watch", runId: RUN_ID }))).toBeNull();
    expect(parseInboundFrame(JSON.stringify({ type: "agent:watch", runId: RUN_ID, afterEventId: "-1" }))).toBeNull();
    expect(
      parseInboundFrame(JSON.stringify({ type: "agent:watch", runId: RUN_ID, afterEventId: "9223372036854775808" })),
    ).toBeNull();
  });
});

describe("parseBinaryFrame (issue #160)", () => {
  it("splits a well-formed binary frame into its 16-byte docId prefix and payload", () => {
    const docId = Buffer.alloc(16, 7);
    const payload = Buffer.from([1, 2, 3]);
    const frame = parseBinaryFrame(Buffer.concat([docId, payload]));
    expect(frame).not.toBeNull();
    expect(frame?.docId).toEqual(docId);
    expect(frame?.payload).toEqual(payload);
  });

  it("accepts a frame with exactly the 16-byte prefix and no payload", () => {
    const docId = Buffer.alloc(16, 1);
    const frame = parseBinaryFrame(docId);
    expect(frame?.docId).toEqual(docId);
    expect(frame?.payload).toEqual(Buffer.alloc(0));
  });

  it("rejects a frame shorter than the 16-byte prefix", () => {
    expect(parseBinaryFrame(Buffer.from([1, 2, 3]))).toBeNull();
  });

  it("rejects an empty frame", () => {
    expect(parseBinaryFrame(Buffer.alloc(0))).toBeNull();
  });
});

describe("decodeDocId/encodeDocId/buildBinaryFrame (issue #162)", () => {
  it("round-trips a UUID through encodeDocId and decodeDocId", () => {
    const encoded = encodeDocId(DOC_ID);
    expect(encoded).toHaveLength(16);
    expect(decodeDocId(encoded)).toBe(DOC_ID);
  });

  it("rejects a prefix that is not exactly 16 bytes", () => {
    expect(decodeDocId(Buffer.alloc(15))).toBeNull();
    expect(decodeDocId(Buffer.alloc(17))).toBeNull();
  });

  it("builds a binary frame as the encoded docId followed by the payload", () => {
    const payload = Uint8Array.from([9, 8, 7]);
    const frame = buildBinaryFrame(DOC_ID, payload);
    const parsed = parseBinaryFrame(frame);
    expect(parsed).not.toBeNull();
    expect(decodeDocId(parsed!.docId)).toBe(DOC_ID);
    expect(parsed?.payload).toEqual(Buffer.from(payload));
  });
});

describe("parseAgentStreamMessage (issue #163)", () => {
  it("rejects an ephemeral delta with a malformed agentRunId", () => {
    expect(parseAgentStreamMessage({ type: "agent_run_delta", agentRunId: "not-a-uuid", delta: {} })).toBeNull();
  });
});

describe("parseRealtimeMessage (issue #163)", () => {
  it("validates every relation invalidation field", () => {
    const valid = {
      type: "invalidation",
      scope: "relation",
      databaseId: RUN_ID,
      itemId: RUN_ID,
      propertyKey: "project",
      op: "put",
      userId: RUN_ID,
    };
    expect(parseRealtimeMessage(valid)).toEqual(valid);
    expect(parseRealtimeMessage({ ...valid, propertyKey: null, op: "metadata" })).toMatchObject({
      propertyKey: null,
      op: "metadata",
    });
    for (const malformed of [
      { databaseId: "bad" },
      { itemId: null },
      { propertyKey: 3 },
      { propertyKey: undefined },
      { op: "update" },
      { userId: "bad" },
    ])
      expect(parseRealtimeMessage({ ...valid, ...malformed })).toBeNull();
  });
  it("validates an approvalRequest invalidation (issue #1789)", () => {
    const valid = { type: "invalidation", scope: "approvalRequest", approvalRequestId: DOC_ID, userId: RUN_ID };
    expect(parseRealtimeMessage(valid)).toEqual(valid);
    // The owner is optional in the catalog; the sync server is what refuses to deliver without one.
    const { userId: _userId, ...withoutOwner } = valid;
    expect(parseRealtimeMessage(withoutOwner)).toEqual(withoutOwner);
    for (const malformed of [
      { approvalRequestId: "not-a-uuid" },
      { approvalRequestId: undefined },
      { approvalRequestId: 7 },
      { userId: "not-a-uuid" },
      { userId: 7 },
    ])
      expect(parseRealtimeMessage({ ...valid, ...malformed })).toBeNull();
  });
  it("validates a mailThread invalidation (issue #1816)", () => {
    const valid = { type: "invalidation", scope: "mailThread", threadId: DOC_ID, userId: RUN_ID };
    expect(parseRealtimeMessage(valid)).toEqual(valid);
    // The user is optional: without one the thread is announced to the whole tenant.
    const { userId: _userId, ...withoutUser } = valid;
    expect(parseRealtimeMessage(withoutUser)).toEqual(withoutUser);
  });
  it("drops a mailThread invalidation whose thread id is not a UUID (issue #1816)", () => {
    const valid = { type: "invalidation", scope: "mailThread", threadId: DOC_ID };
    for (const malformed of [
      { threadId: "not-a-uuid" },
      { threadId: "" },
      { threadId: undefined },
      { threadId: null },
      { threadId: 7 },
      { userId: "not-a-uuid" },
      { userId: 7 },
    ])
      expect(parseRealtimeMessage({ ...valid, ...malformed })).toBeNull();
  });
  it.each(["created", "updated", "closed"] as const)("validates an inboxCards %s invalidation (issue #1811)", (op) => {
    const valid = { type: "invalidation", scope: "inboxCards", op, cardId: DOC_ID, userId: RUN_ID };
    expect(parseRealtimeMessage(valid)).toEqual(valid);
    // The user is optional: it only narrows delivery inside the tenant.
    const { userId: _userId, ...withoutUser } = valid;
    expect(parseRealtimeMessage(withoutUser)).toEqual(withoutUser);
  });
  it("drops a malformed inboxCards invalidation (issue #1811)", () => {
    const valid = { type: "invalidation", scope: "inboxCards", op: "closed", cardId: DOC_ID, userId: RUN_ID };
    for (const malformed of [
      { op: "deleted" },
      { op: undefined },
      { op: 1 },
      { cardId: "not-a-uuid" },
      { cardId: undefined },
      { cardId: 7 },
      { userId: "not-a-uuid" },
      { userId: 7 },
    ])
      expect(parseRealtimeMessage({ ...valid, ...malformed })).toBeNull();
  });
  it("carries no card content in a parsed inboxCards invalidation (issue #1811)", () => {
    const parsed = parseRealtimeMessage({
      type: "invalidation",
      scope: "inboxCards",
      op: "updated",
      cardId: DOC_ID,
      status: "proposed",
      proposal: { entityKind: "database" },
      history: [{ message: "private" }],
    });
    expect(parsed).toEqual({
      type: "invalidation",
      scope: "inboxCards",
      op: "updated",
      cardId: DOC_ID,
      userId: undefined,
    });
  });
  it("rejects an agent-run reference with a malformed eventId", () => {
    expect(parseRealtimeMessage({ type: "agent_run_event", agentRunId: RUN_ID, eventId: "abc" })).toBeNull();
  });
});

describe("parseRealtimeEnvelope / parseAgentStreamEnvelope (issue #1025)", () => {
  const TENANT_ID = "33333333-3333-3333-3333-333333333333";
  const realtimeMessage = { type: "session_revoked", sessionId: "s-1" };
  const streamMessage = { type: "agent_run_delta", agentRunId: RUN_ID, delta: "x" };

  it("accepts a valid envelope on both channels", () => {
    expect(parseRealtimeEnvelope({ tenantId: TENANT_ID, message: realtimeMessage })).toEqual({
      tenantId: TENANT_ID,
      message: realtimeMessage,
    });
    expect(parseAgentStreamEnvelope({ tenantId: TENANT_ID, message: streamMessage })).toEqual({
      tenantId: TENANT_ID,
      message: streamMessage,
    });
  });

  it.each([
    ["a missing tenantId", { message: realtimeMessage }],
    ["a null tenantId", { tenantId: null, message: realtimeMessage }],
    ["a non-uuid tenantId", { tenantId: "tenant-1", message: realtimeMessage }],
    ["an invalid inner message", { tenantId: TENANT_ID, message: { type: "nope" } }],
    ["a missing inner message", { tenantId: TENANT_ID }],
    ["the bare pre-envelope message", realtimeMessage],
    ["null", null],
    ["an array", []],
  ])("rejects %s on the realtime channel", (_label, raw) => {
    expect(parseRealtimeEnvelope(raw)).toBeNull();
  });

  it.each([
    ["a missing tenantId", { message: streamMessage }],
    ["a null tenantId", { tenantId: null, message: streamMessage }],
    ["a non-uuid tenantId", { tenantId: "tenant-1", message: streamMessage }],
    ["an invalid inner message", { tenantId: TENANT_ID, message: { type: "agent_run_delta" } }],
    ["the bare pre-envelope message", streamMessage],
  ])("rejects %s on the agent stream channel", (_label, raw) => {
    expect(parseAgentStreamEnvelope(raw)).toBeNull();
  });
});

describe("client update id helpers (issue #1362)", () => {
  function updateMessage(): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 2);
    encoding.writeVarUint8Array(encoder, new Uint8Array([1, 2, 3]));
    return encoding.toUint8Array(encoder);
  }

  function readAfterUpdate(payload: Uint8Array): string | null {
    const decoder = decoding.createDecoder(payload);
    decoding.readVarUint(decoder);
    decoding.readVarUint8Array(decoder);
    return readClientUpdateId(decoder);
  }

  it("round-trips an id appended after the update bytes", () => {
    expect(readAfterUpdate(appendClientUpdateId(updateMessage(), "edit_1-A"))).toBe("edit_1-A");
  });

  it("keeps the leading message readable by a reader that ignores the id", () => {
    const decoder = decoding.createDecoder(appendClientUpdateId(updateMessage(), "x"));
    expect(decoding.readVarUint(decoder)).toBe(2);
    expect(Array.from(decoding.readVarUint8Array(decoder))).toEqual([1, 2, 3]);
  });

  it("returns null when nothing follows the update bytes", () => {
    expect(readAfterUpdate(updateMessage())).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["over 64 characters", "a".repeat(65)],
    ["other characters", "has space"],
    ["non-ASCII", "idé"],
  ])("treats an id that is %s as no id", (_label, id) => {
    expect(readAfterUpdate(appendClientUpdateId(updateMessage(), id))).toBeNull();
  });

  it("returns null instead of throwing on a truncated trailing varString", () => {
    const payload = appendClientUpdateId(updateMessage(), "abcdef");
    expect(readAfterUpdate(payload.subarray(0, payload.length - 3))).toBeNull();
  });

  it("returns null on a trailing varString length that is not a valid varint", () => {
    const payload = Uint8Array.from([...updateMessage(), 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(readAfterUpdate(payload)).toBeNull();
  });

  it("accepts exactly 1 to 64 characters of [A-Za-z0-9_-]", () => {
    expect(isClientUpdateId("a")).toBe(true);
    expect(isClientUpdateId("a".repeat(64))).toBe(true);
    expect(isClientUpdateId("a".repeat(65))).toBe(false);
    expect(isClientUpdateId("")).toBe(false);
    expect(isClientUpdateId("a.b")).toBe(false);
    expect(isClientUpdateId(5)).toBe(false);
  });
});
