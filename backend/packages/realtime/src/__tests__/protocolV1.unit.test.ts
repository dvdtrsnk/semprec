import { describe, expect, it } from "vitest";
import { buildBinaryFrame, decodeDocId, encodeDocId, parseBinaryFrame, parseInboundFrame } from "../protocolV1.js";

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
    expect(parseInboundFrame(JSON.stringify({ type: "agent:watch", agentRunId: RUN_ID }))).toEqual({
      type: "agent:watch",
      agentRunId: RUN_ID,
    });
  });

  it("accepts a well-formed agent:unwatch frame", () => {
    expect(parseInboundFrame(JSON.stringify({ type: "agent:unwatch", agentRunId: RUN_ID }))).toEqual({
      type: "agent:unwatch",
      agentRunId: RUN_ID,
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
    expect(parseInboundFrame(JSON.stringify({ type: "agent:watch", agentRunId: 123 }))).toBeNull();
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
