import { afterEach, describe, expect, it, vi } from "vitest";
import { createDocInvalidationThrottle } from "../docInvalidationThrottle.js";

function frame(docId: string, lastEditedAt: string) {
  return { type: "invalidate", scope: "doc", docId, itemId: "item", databaseId: "database", lastEditedAt } as const;
}

afterEach(() => vi.useRealTimers());

describe("document invalidation throttle", () => {
  it("waits for a held leading read, coalesces a burst and sends fresh decreasing state", async () => {
    vi.useFakeTimers();
    let release!: (value: ReturnType<typeof frame>) => void;
    const held = new Promise<ReturnType<typeof frame>>((resolve) => (release = resolve));
    const resolve = vi.fn().mockReturnValueOnce(held).mockResolvedValueOnce(frame("doc", "earlier"));
    const send = vi.fn();
    const throttle = createDocInvalidationThrottle(resolve, send, vi.fn());
    throttle.enqueue("tenant", "doc");
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 99; i += 1) throttle.enqueue("tenant", "doc");
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolve).toHaveBeenCalledTimes(1);
    release(frame("doc", "later"));
    await vi.advanceTimersByTimeAsync(0);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(send.mock.calls).toEqual([
      ["tenant", frame("doc", "later")],
      ["tenant", frame("doc", "earlier")],
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
    await throttle.close();
  });

  it("retains a signal that arrives after the boundary while the leading lookup is held", async () => {
    vi.useFakeTimers();
    let release!: (value: ReturnType<typeof frame>) => void;
    const held = new Promise<ReturnType<typeof frame>>((resolve) => (release = resolve));
    const resolve = vi.fn().mockReturnValueOnce(held).mockResolvedValueOnce(frame("doc", "2"));
    const send = vi.fn();
    const throttle = createDocInvalidationThrottle(resolve, send, vi.fn());
    throttle.enqueue("tenant", "doc");
    await vi.advanceTimersByTimeAsync(1000);
    throttle.enqueue("tenant", "doc");
    release(frame("doc", "1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((call) => call[1])).toEqual([frame("doc", "1"), frame("doc", "2")]);
    await throttle.close();
  });

  it("defers signals during a held trailing lookup to the next window without overlapping reads", async () => {
    vi.useFakeTimers();
    let release!: (value: ReturnType<typeof frame>) => void;
    const held = new Promise<ReturnType<typeof frame>>((resolve) => (release = resolve));
    const resolve = vi
      .fn()
      .mockResolvedValueOnce(frame("doc", "1"))
      .mockReturnValueOnce(held)
      .mockResolvedValueOnce(frame("doc", "3"));
    const send = vi.fn();
    const throttle = createDocInvalidationThrottle(resolve, send, vi.fn());
    throttle.enqueue("tenant", "doc");
    await vi.advanceTimersByTimeAsync(0);
    throttle.enqueue("tenant", "doc");
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolve).toHaveBeenCalledTimes(2);
    throttle.enqueue("tenant", "doc");
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolve).toHaveBeenCalledTimes(2);
    release(frame("doc", "2"));
    await vi.advanceTimersByTimeAsync(0);
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.map((call) => call[1])).toEqual([frame("doc", "1"), frame("doc", "2"), frame("doc", "3")]);
    await throttle.close();
  });

  it("keeps keys independent, reports failure, skips missing rows, and joins held work on close", async () => {
    vi.useFakeTimers();
    let release!: (value: ReturnType<typeof frame>) => void;
    const held = new Promise<ReturnType<typeof frame>>((resolve) => (release = resolve));
    const resolve = vi
      .fn()
      .mockRejectedValueOnce(new Error("private"))
      .mockResolvedValueOnce(null)
      .mockReturnValueOnce(held);
    const send = vi.fn();
    const report = vi.fn();
    const throttle = createDocInvalidationThrottle(resolve, send, report);
    throttle.enqueue("a", "one");
    throttle.enqueue("b", "one");
    throttle.enqueue("a", "two");
    await vi.advanceTimersByTimeAsync(0);
    expect(report).toHaveBeenCalledTimes(1);
    let closed = false;
    const closing = throttle.close().then(() => (closed = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    throttle.enqueue("a", "three");
    release(frame("two", "1"));
    await closing;
    expect(closed).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(send).not.toHaveBeenCalled();
  });
});
