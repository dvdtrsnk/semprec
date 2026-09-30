import { describe, expect, it } from "vitest";
import { QUEUE_CONCURRENCY_DEFAULT, resolveQueueConcurrency } from "../index.js";

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
