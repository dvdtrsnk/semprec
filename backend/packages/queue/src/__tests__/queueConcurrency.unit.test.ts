import { describe, expect, it } from "vitest";
import { QUEUE_CONCURRENCY_DEFAULT, resolveQueueConcurrency, resolveSempChatQueueConcurrency } from "../index.js";

describe("resolveQueueConcurrency", () => {
  it("falls back to the default when QUEUE_CONCURRENCY is unset", () => {
    expect(resolveQueueConcurrency({})).toBe(QUEUE_CONCURRENCY_DEFAULT);
  });

  it("falls back to the default when QUEUE_CONCURRENCY is empty", () => {
    expect(resolveQueueConcurrency({ QUEUE_CONCURRENCY: "" })).toBe(QUEUE_CONCURRENCY_DEFAULT);
  });

  it("parses a positive integer string", () => {
    expect(resolveQueueConcurrency({ QUEUE_CONCURRENCY: "8" })).toBe(8);
  });

  it.each(["0", "-1", "abc", "2.5"])("throws naming the variable for %s", (raw) => {
    expect(() => resolveQueueConcurrency({ QUEUE_CONCURRENCY: raw })).toThrow(
      `QUEUE_CONCURRENCY is not a positive integer: ${raw}`,
    );
  });
});

describe("resolveSempChatQueueConcurrency", () => {
  it("defaults to two for unset or empty values", () => {
    expect(resolveSempChatQueueConcurrency({})).toBe(2);
    expect(resolveSempChatQueueConcurrency({ SEMP_CHAT_QUEUE_CONCURRENCY: "" })).toBe(2);
  });

  it("accepts a positive integer", () => {
    expect(resolveSempChatQueueConcurrency({ SEMP_CHAT_QUEUE_CONCURRENCY: "3" })).toBe(3);
  });

  it.each(["0", "-1", "abc", "2.5"])("rejects %s", (raw) => {
    expect(() => resolveSempChatQueueConcurrency({ SEMP_CHAT_QUEUE_CONCURRENCY: raw })).toThrow(
      `SEMP_CHAT_QUEUE_CONCURRENCY is not a positive integer: ${raw}`,
    );
  });
});
