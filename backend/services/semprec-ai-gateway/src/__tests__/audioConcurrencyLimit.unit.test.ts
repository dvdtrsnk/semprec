import { describe, expect, it } from "vitest";
import { createAudioConcurrencyLimit } from "../audioConcurrencyLimit.js";

describe("createAudioConcurrencyLimit", () => {
  it("admits up to max acquisitions and refuses the next with null", () => {
    const limit = createAudioConcurrencyLimit(2);

    const first = limit.tryAcquire();
    const second = limit.tryAcquire();
    const third = limit.tryAcquire();

    expect(first).toBeTypeOf("function");
    expect(second).toBeTypeOf("function");
    expect(third).toBeNull();
    expect(limit.inFlight()).toBe(2);
  });

  it("frees a slot on release so the next acquisition is admitted", () => {
    const limit = createAudioConcurrencyLimit(1);
    const release = limit.tryAcquire();
    expect(limit.tryAcquire()).toBeNull();

    release?.();

    expect(limit.inFlight()).toBe(0);
    expect(limit.tryAcquire()).toBeTypeOf("function");
    expect(limit.inFlight()).toBe(1);
  });

  it("decrements only once when the same release function is called twice", () => {
    const limit = createAudioConcurrencyLimit(2);
    const first = limit.tryAcquire();
    limit.tryAcquire();

    first?.();
    first?.();

    expect(limit.inFlight()).toBe(1);
  });
});
