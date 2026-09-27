import { describe, expect, it, vi } from "vitest";
import { createSessionFetch } from "../sessionFetch.js";

describe("createSessionFetch", () => {
  it("invokes the callback exactly once on a 401 and returns the response unchanged", async () => {
    const response = new Response("{}", { status: 401 });
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn(async () => response);
    const sessionFetch = createSessionFetch(onUnauthorized, fetchImpl);

    const init = { method: "GET" };
    const result = await sessionFetch("/api/items", init);

    expect(result).toBe(response);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith("/api/items", init);
  });

  it.each([200, 404])("does not invoke the callback on a %i", async (status) => {
    const response = new Response("{}", { status });
    const onUnauthorized = vi.fn();
    const sessionFetch = createSessionFetch(onUnauthorized, async () => response);

    await expect(sessionFetch("/api/items")).resolves.toBe(response);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("propagates a rejected fetch without invoking the callback", async () => {
    const onUnauthorized = vi.fn();
    const failure = new TypeError("Failed to fetch");
    const sessionFetch = createSessionFetch(onUnauthorized, async () => {
      throw failure;
    });

    await expect(sessionFetch("/api/items")).rejects.toBe(failure);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
