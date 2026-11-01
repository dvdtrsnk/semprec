import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  SEMP_MESSAGE_REF_KINDS,
  labeledSempMessageRefSchema,
  messageRefKey,
  sempMessageRefSchema,
} from "../sempMessageRef.js";

const id = () => randomUUID();

const valid: Record<string, Record<string, unknown>> = {
  item: { kind: "item", itemId: id(), databaseId: id() },
  block: { kind: "block", itemId: id(), blockId: id() },
  transcriptSegment: { kind: "transcriptSegment", itemId: id(), startsAt: 1.5, endsAt: 4 },
  mailAttachment: { kind: "mailAttachment", attachmentId: id() },
  agentRun: { kind: "agentRun", agentRunId: id(), messageId: id() },
  approvalRequest: { kind: "approvalRequest", approvalRequestId: id() },
};

describe("sempMessageRefSchema", () => {
  it("covers every kind with a fixture", () => {
    expect(Object.keys(valid).sort()).toEqual([...SEMP_MESSAGE_REF_KINDS].sort());
  });

  for (const [kind, value] of Object.entries(valid)) {
    describe(kind, () => {
      it("accepts a valid value", () => {
        expect(sempMessageRefSchema.parse(value)).toEqual(value);
      });

      it("rejects an extra field", () => {
        expect(sempMessageRefSchema.safeParse({ ...value, extra: 1 }).success).toBe(false);
      });

      it("accepts the labeled variant and rejects missing labels and expanded fields", () => {
        expect(labeledSempMessageRefSchema.parse({ ...value, label: "At send time" })).toEqual({
          ...value,
          label: "At send time",
        });
        expect(labeledSempMessageRefSchema.safeParse(value).success).toBe(false);
        expect(labeledSempMessageRefSchema.safeParse({ ...value, label: 1 }).success).toBe(false);
        expect(labeledSempMessageRefSchema.safeParse({ ...value, label: "x", expanded: "secret" }).success).toBe(false);
      });

      const required = Object.keys(value).filter((k) => k !== "kind" && k !== "messageId");
      for (const field of required) {
        it(`rejects a missing ${field}`, () => {
          const { [field]: _omitted, ...rest } = value;
          expect(sempMessageRefSchema.safeParse(rest).success).toBe(false);
        });
      }

      for (const field of required.filter((k) => k.endsWith("Id"))) {
        it(`rejects a non-UUID ${field}`, () => {
          expect(sempMessageRefSchema.safeParse({ ...value, [field]: "not-a-uuid" }).success).toBe(false);
        });
      }
    });
  }

  it("accepts an agent run ref without messageId", () => {
    expect(sempMessageRefSchema.safeParse({ kind: "agentRun", agentRunId: id() }).success).toBe(true);
  });

  it("rejects a non-UUID messageId on an agent run ref", () => {
    expect(sempMessageRefSchema.safeParse({ kind: "agentRun", agentRunId: id(), messageId: "x" }).success).toBe(false);
  });

  it("rejects an unknown kind", () => {
    expect(sempMessageRefSchema.safeParse({ kind: "recording", itemId: id() }).success).toBe(false);
  });

  describe("transcriptSegment range", () => {
    const base = { kind: "transcriptSegment", itemId: id() };
    it.each([
      ["empty", 3, 3],
      ["reversed", 5, 2],
      ["negative start", -1, 2],
      ["infinite end", 0, Infinity],
      ["NaN start", NaN, 2],
    ])("rejects a %s range", (_name, startsAt, endsAt) => {
      expect(sempMessageRefSchema.safeParse({ ...base, startsAt, endsAt }).success).toBe(false);
    });

    it("accepts a range starting at zero", () => {
      expect(sempMessageRefSchema.safeParse({ ...base, startsAt: 0, endsAt: 0.5 }).success).toBe(true);
    });
  });
});

describe("messageRefKey", () => {
  const parse = (v: unknown) => sempMessageRefSchema.parse(v);

  it("is equal for two equal refs and distinct across kinds", () => {
    for (const value of Object.values(valid)) {
      expect(messageRefKey(parse(value))).toBe(messageRefKey(parse({ ...value })));
    }
    expect(new Set(Object.values(valid).map((v) => messageRefKey(parse(v)))).size).toBe(Object.keys(valid).length);
  });

  it("differs for refs differing in block id", () => {
    const itemId = id();
    expect(messageRefKey(parse({ kind: "block", itemId, blockId: id() }))).not.toBe(
      messageRefKey(parse({ kind: "block", itemId, blockId: id() })),
    );
  });

  it("differs for refs differing in range", () => {
    const itemId = id();
    const seg = (startsAt: number, endsAt: number) =>
      messageRefKey(parse({ kind: "transcriptSegment", itemId, startsAt, endsAt }));
    expect(seg(1, 2)).not.toBe(seg(1, 3));
    expect(seg(1, 2)).not.toBe(seg(0, 2));
  });

  it("ignores messageId of an agent run ref", () => {
    const agentRunId = id();
    const key = (messageId?: string) => messageRefKey(parse({ kind: "agentRun", agentRunId, messageId }));
    expect(key(id())).toBe(key(id()));
    expect(key(id())).toBe(key());
  });
});
