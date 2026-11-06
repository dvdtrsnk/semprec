import { describe, expect, it } from "vitest";
import { VoiceDeltaBufferError, VoiceRunDeltaBuffer } from "../voiceRunDeltaBuffer.js";

const run = "11111111-1111-4111-8111-111111111111";
const messageId = "22222222-2222-4222-8222-222222222222";
const chunkId = "33333333-3333-4333-8333-333333333333";
const delta = (anchor: string, sequence: number, value: unknown) => ({
  type: "agent_run_delta" as const,
  agentRunId: run,
  sempMessageId: messageId,
  afterEventId: anchor,
  deltaSequence: sequence,
  delta: value,
});
const chunk = (anchor: string, sequence: number, index: number, total: number, value: string, id = chunkId) => ({
  ...delta(anchor, sequence, value),
  delta: value,
  chunk: { id, index, total, encoding: "base64json" as const },
});

describe("bounded voice delta buffer", () => {
  it("reassembles one canonical base64 JSON value across non-ASCII byte boundaries", () => {
    const buffer = new VoiceRunDeltaBuffer("1");
    const value = { kind: "message_update", text: "😀ž".repeat(1400) };
    const encoded = Buffer.from(JSON.stringify(value)).toString("base64");
    const pieces = encoded.match(/.{1,7000}/g) ?? [];
    expect(pieces.length).toBeGreaterThan(1);
    for (const [index, part] of pieces.entries()) buffer.admit(chunk("1", 1, index, pieces.length, part), index);
    expect(buffer.shift()?.delta).toEqual(value);
    expect(buffer.shift()).toBeUndefined();
  });

  it("accepts identical duplicates and rejects conflicts without replaying consumed ordinals", () => {
    const buffer = new VoiceRunDeltaBuffer("1");
    buffer.admit(chunk("1", 1, 0, 2, "eyJ4"), 0);
    buffer.admit(chunk("1", 1, 0, 2, "eyJ4"), 1);
    expect(() => buffer.admit(chunk("1", 1, 0, 2, "eyJ5"), 2)).toThrow(VoiceDeltaBufferError);
    buffer.admit(chunk("1", 1, 1, 2, "IjoxfQ=="), 3);
    expect(buffer.shift()?.delta).toEqual({ x: 1 });
    buffer.admit(chunk("1", 1, 0, 2, "eyJ5"), 4);
    expect(buffer.peek()).toBeUndefined();
  });

  it("suppresses gaps and interleaving for the affected anchor and rejects malformed encodings", () => {
    const buffer = new VoiceRunDeltaBuffer("1");
    buffer.admit(delta("1", 2, { text: "gap" }), 0);
    buffer.admit(delta("1", 1, { text: "late" }), 1);
    expect(buffer.peek()).toBeUndefined();
    buffer.admit(chunk("2", 1, 0, 2, "eyJ4"), 2);
    expect(() => buffer.admit(chunk("2", 1, 1, 2, "IjoxfQ==", "44444444-4444-4444-8444-444444444444"), 3)).toThrow(
      VoiceDeltaBufferError,
    );
    buffer.clear();
    expect(() => buffer.admit(chunk("2", 1, 0, 1, "===="), 4)).toThrow(VoiceDeltaBufferError);
  });

  it("ignores consumed ordinals before checking a newer active assembly", () => {
    const buffer = new VoiceRunDeltaBuffer("1");
    buffer.admit(delta("1", 1, { text: "first" }), 0);
    expect(buffer.shift()?.delta).toEqual({ text: "first" });
    buffer.admit(chunk("1", 2, 0, 2, "eyJ4"), 1);
    const deadline = buffer.deadline;
    buffer.admit(delta("1", 1, { text: "first" }), 2);
    buffer.admit(delta("1", 1, { text: "different" }), 3);
    buffer.admit(chunk("1", 1, 0, 2, "eyJ4"), 4);
    buffer.admit(chunk("1", 1, 0, 2, "eyJ5"), 5);
    expect(buffer.deadline).toBe(deadline);
    expect(buffer.peek()).toBeUndefined();
    buffer.admit(chunk("1", 2, 1, 2, "IjoxfQ=="), 6);
    expect(buffer.shift()?.delta).toEqual({ x: 1 });
    expect(buffer.shift()).toBeUndefined();
  });

  it("bounds logical count, serialized bytes, fragment metadata and absolute expiration", () => {
    const buffer = new VoiceRunDeltaBuffer("1");
    for (let i = 1; i <= 256; i++) buffer.admit(delta("1", i, "x"), 0);
    expect(() => buffer.admit(delta("1", 257, "x"), 0)).toThrow(VoiceDeltaBufferError);
    buffer.clear();
    buffer.admit(delta("1", 1, "x".repeat(262142)), 0);
    expect(() => buffer.admit(delta("1", 2, "x".repeat(262143)), 0)).toThrow(VoiceDeltaBufferError);
    buffer.clear();
    expect(() => buffer.admit(chunk("1", 1, 0, 51, "e30="), 0)).toThrow(VoiceDeltaBufferError);
    buffer.admit(chunk("2", 1, 0, 2, "eyJ4"), 100);
    expect(buffer.deadline).toBe(5100);
    buffer.expire(5100);
    buffer.admit(chunk("2", 1, 1, 2, "IjoxfQ=="), 5101);
    expect(buffer.peek()).toBeUndefined();
    buffer.advance("3");
    buffer.admit(delta("2", 1, "stale"), 5102);
    expect(buffer.peek()).toBeUndefined();
  });

  it("admits exact decoded and encoded limits while refusing malformed or oversized values", () => {
    const buffer = new VoiceRunDeltaBuffer("1");
    const value = "x".repeat(262142);
    const encoded = Buffer.from(JSON.stringify(value)).toString("base64");
    expect(Buffer.byteLength(JSON.stringify(value))).toBe(262144);
    expect(encoded.length).toBe(349528);
    const parts = encoded.match(/.{1,7000}/g) ?? [];
    expect(parts).toHaveLength(50);
    for (const [index, part] of parts.entries()) buffer.admit(chunk("1", 1, index, parts.length, part), 0);
    expect(buffer.shift()?.delta).toBe(value);
    buffer.clear();
    expect(() => {
      for (let index = 0; index < 50; index++) buffer.admit(chunk("1", 1, index, 50, "A".repeat(7000)), 0);
    }).toThrow(VoiceDeltaBufferError);
    buffer.clear();
    expect(() => buffer.admit(chunk("1", 1, 0, 1, Buffer.from([0xff]).toString("base64")), 0)).toThrow(
      VoiceDeltaBufferError,
    );
    buffer.clear();
    expect(() => buffer.admit(chunk("1", 1, 0, 1, Buffer.from("not json").toString("base64")), 0)).toThrow(
      VoiceDeltaBufferError,
    );
  });

  it("admits exactly 512 KiB of pending serialized content and rejects one more value as overload", () => {
    const buffer = new VoiceRunDeltaBuffer("1");
    const value = "x".repeat(262142);
    buffer.admit(delta("1", 1, value), 0);
    buffer.admit(delta("1", 2, value), 0);
    let failure: unknown;
    try {
      buffer.admit(delta("1", 3, null), 0);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ causeCode: "overloaded" });
    expect(buffer.shift()?.delta).toBe(value);
    expect(buffer.shift()?.delta).toBe(value);
    expect(buffer.shift()).toBeUndefined();
  });

  it("suppresses out-of-order and interleaved assemblies without stitching later data", () => {
    const buffer = new VoiceRunDeltaBuffer("1");
    buffer.admit(chunk("1", 1, 1, 2, "IjoxfQ=="), 0);
    buffer.admit(chunk("1", 1, 0, 2, "eyJ4"), 1);
    expect(buffer.peek()).toBeUndefined();
    buffer.admit(chunk("2", 1, 0, 2, "eyJ4"), 2);
    buffer.admit(chunk("3", 1, 0, 2, "eyJ5"), 3);
    buffer.admit(chunk("2", 1, 1, 2, "IjoxfQ=="), 4);
    buffer.admit(chunk("3", 1, 1, 2, "IjoyfQ=="), 5);
    expect(buffer.peek()).toBeUndefined();
    buffer.clear();
    buffer.admit(delta("4", 1, "fresh"), 6);
    expect(buffer.shift()?.delta).toBe("fresh");
  });
});
