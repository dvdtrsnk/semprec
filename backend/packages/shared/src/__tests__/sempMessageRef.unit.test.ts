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
  mailThread: { kind: "mailThread", threadId: id() },
  agentRun: { kind: "agentRun", agentRunId: id(), messageId: id() },
  approvalRequest: { kind: "approvalRequest", approvalRequestId: id() },
  taskOccurrence: { kind: "taskOccurrence", seriesId: id(), occurrenceDate: "2026-11-16" },
  taskTrace: { kind: "taskTrace", itemId: id(), databaseId: id(), traceDay: "2026-11-02" },
  sleepNight: { kind: "sleepNight", night: "2026-10-16" },
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

      // `seriesId` is deliberately any non-empty string on the wire; only a series of the tenant makes a ref valid.
      for (const field of required.filter((k) => k.endsWith("Id") && k !== "seriesId")) {
        it(`rejects a non-UUID ${field}`, () => {
          expect(sempMessageRefSchema.safeParse({ ...value, [field]: "not-a-uuid" }).success).toBe(false);
        });
      }
    });
  }

  it("accepts an agent run ref without messageId", () => {
    expect(sempMessageRefSchema.safeParse({ kind: "agentRun", agentRunId: id() }).success).toBe(true);
  });

  it("rejects a messageId on every kind other than agentRun, stored with a label or not (issue gh-1936)", () => {
    for (const [kind, value] of Object.entries(valid)) {
      if (kind === "agentRun") continue;
      expect(sempMessageRefSchema.safeParse({ ...value, messageId: id() }).success, kind).toBe(false);
      expect(labeledSempMessageRefSchema.safeParse({ ...value, label: "L", messageId: id() }).success, kind).toBe(
        false,
      );
    }
  });

  it("keeps the messageId of an agent run ref as given, with or without a stored label (issue gh-1936)", () => {
    const ref = { kind: "agentRun", agentRunId: id(), messageId: id() };
    expect(sempMessageRefSchema.parse(ref)).toEqual(ref);
    expect(labeledSempMessageRefSchema.parse({ ...ref, label: "Run" })).toEqual({ ...ref, label: "Run" });
  });

  it("rejects a non-UUID messageId on an agent run ref", () => {
    expect(sempMessageRefSchema.safeParse({ kind: "agentRun", agentRunId: id(), messageId: "x" }).success).toBe(false);
  });

  it("rejects an unknown kind", () => {
    expect(sempMessageRefSchema.safeParse({ kind: "recording", itemId: id() }).success).toBe(false);
  });

  describe("task references (issue #1771)", () => {
    const occurrence = (overrides: Record<string, unknown>) => ({ ...valid.taskOccurrence, ...overrides });
    const trace = (overrides: Record<string, unknown>) => ({ ...valid.taskTrace, ...overrides });

    it("accepts any non-empty series id and refuses an empty or non-string one", () => {
      expect(sempMessageRefSchema.safeParse(occurrence({ seriesId: "not-a-uuid" })).success).toBe(true);
      expect(sempMessageRefSchema.safeParse(occurrence({ seriesId: "" })).success).toBe(false);
      expect(sempMessageRefSchema.safeParse(occurrence({ seriesId: 7 })).success).toBe(false);
    });

    it("carries no item id on an occurrence and refuses one, as it refuses any extra key", () => {
      expect(sempMessageRefSchema.safeParse(occurrence({ itemId: id() })).success).toBe(false);
      expect(sempMessageRefSchema.safeParse(trace({ blockId: id() })).success).toBe(false);
    });

    it.each([
      "2026-1-01",
      "26-11-02",
      "2026-11-02T00:00:00Z",
      "2026-13-01",
      "2026-02-30",
      "2026-00-10",
      "",
      "tomorrow",
    ])("refuses %j as the day of an occurrence or a trace", (day) => {
      expect(sempMessageRefSchema.safeParse(occurrence({ occurrenceDate: day })).success).toBe(false);
      expect(sempMessageRefSchema.safeParse(trace({ traceDay: day })).success).toBe(false);
    });

    it("accepts a leap day and refuses it in a common year", () => {
      expect(sempMessageRefSchema.safeParse(occurrence({ occurrenceDate: "2028-02-29" })).success).toBe(true);
      expect(sempMessageRefSchema.safeParse(occurrence({ occurrenceDate: "2027-02-29" })).success).toBe(false);
    });

    it("keys an occurrence by series and day and a trace by task, database and day", () => {
      const seriesId = id();
      const itemId = id();
      const databaseId = id();
      const key = (value: unknown) => messageRefKey(sempMessageRefSchema.parse(value));
      expect(key(occurrence({ seriesId }))).toBe(key(occurrence({ seriesId })));
      expect(key(occurrence({ seriesId }))).not.toBe(key(occurrence({ seriesId, occurrenceDate: "2026-11-17" })));
      expect(key(occurrence({ seriesId }))).not.toBe(key(occurrence({ seriesId: id() })));
      expect(key(trace({ itemId, databaseId }))).toBe(key(trace({ itemId, databaseId })));
      expect(key(trace({ itemId, databaseId }))).not.toBe(key(trace({ itemId, databaseId, traceDay: "2026-11-03" })));
      expect(key(trace({ itemId, databaseId }))).not.toBe(key(trace({ itemId: id(), databaseId })));
    });
  });

  describe("sleep night reference (issue #1853)", () => {
    const night = (value: unknown) => ({ kind: "sleepNight", night: value });

    it.each([
      "2026-13-01",
      "2026-02-30",
      "2027-02-29",
      "2026-00-10",
      "2026-10-00",
      "2026-1-01",
      "2026-10-16T00:00:00Z",
      " 2026-10-16",
      "",
      "tonight",
    ])("refuses %j as the night", (value) => {
      expect(sempMessageRefSchema.safeParse(night(value)).success).toBe(false);
      expect(labeledSempMessageRefSchema.safeParse({ ...night(value), label: "Night" }).success).toBe(false);
    });

    it("refuses a night that is not a string", () => {
      expect(sempMessageRefSchema.safeParse(night(20261016)).success).toBe(false);
      expect(sempMessageRefSchema.safeParse({ kind: "sleepNight" }).success).toBe(false);
    });

    it("accepts a leap day and refuses it in a common year", () => {
      expect(sempMessageRefSchema.safeParse(night("2028-02-29")).success).toBe(true);
      expect(sempMessageRefSchema.safeParse(night("2027-02-29")).success).toBe(false);
    });

    it("carries no item id and refuses one, as it refuses any extra key", () => {
      expect(sempMessageRefSchema.safeParse({ ...night("2026-10-16"), itemId: id() }).success).toBe(false);
      expect(sempMessageRefSchema.safeParse({ ...night("2026-10-16"), databaseId: id() }).success).toBe(false);
    });

    it("keys a night as sleepNight:<night>, equal for equal nights and distinct for different ones", () => {
      const key = (value: unknown) => messageRefKey(sempMessageRefSchema.parse(value));
      expect(key(night("2026-10-16"))).toBe("sleepNight:2026-10-16");
      expect(key(night("2026-10-16"))).toBe(key(night("2026-10-16")));
      expect(key(night("2026-10-16"))).not.toBe(key(night("2026-10-17")));
    });
  });

  describe("mail thread reference (issue gh-1933)", () => {
    it("carries only the thread id and refuses an item id, a database id or a thread item id beside it", () => {
      const threadId = id();
      for (const extra of ["itemId", "databaseId", "threadItemId", "messageId"]) {
        expect(sempMessageRefSchema.safeParse({ kind: "mailThread", threadId, [extra]: id() }).success).toBe(false);
      }
    });

    it("refuses an item ref in place of a thread ref, and a thread ref with the item fields", () => {
      expect(sempMessageRefSchema.safeParse({ kind: "mailThread", itemId: id(), databaseId: id() }).success).toBe(
        false,
      );
      expect(sempMessageRefSchema.safeParse({ kind: "item", threadId: id() }).success).toBe(false);
    });

    it("keys a thread as mailThread:<threadId>, by the id as given", () => {
      const key = (value: unknown) => messageRefKey(sempMessageRefSchema.parse(value));
      const threadId = id();
      expect(key({ kind: "mailThread", threadId })).toBe(`mailThread:${threadId}`);
      expect(key({ kind: "mailThread", threadId })).toBe(key({ kind: "mailThread", threadId }));
      expect(key({ kind: "mailThread", threadId })).not.toBe(key({ kind: "mailThread", threadId: id() }));
      expect(key({ kind: "mailThread", threadId })).not.toBe(key({ kind: "mailAttachment", attachmentId: threadId }));
    });
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

  it("includes the messageId of an agent run ref, so each answer and the whole run are distinct refs (issue gh-1936)", () => {
    const agentRunId = id();
    const key = (messageId?: string) => messageRefKey(parse({ kind: "agentRun", agentRunId, messageId }));
    const answer = id();
    expect(key(answer)).toBe(key(answer));
    expect(key()).toBe(key());
    expect(key(answer)).not.toBe(key(id()));
    expect(key(answer)).not.toBe(key());
    expect(key()).not.toBe(messageRefKey(parse({ kind: "agentRun", agentRunId: id() })));
  });
});
