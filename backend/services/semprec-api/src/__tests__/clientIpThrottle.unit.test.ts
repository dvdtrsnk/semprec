import { describe, expect, it } from "vitest";
import {
  CLIENT_IP_THROTTLE_LIMITS,
  createClientIpThrottle,
  throttleKeyForIp,
  type ThrottledAction,
} from "../clientIpThrottle.js";

function makeClock(startMs = 1_000_000): { now: () => number; advanceSeconds: (seconds: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advanceSeconds: (seconds) => {
      current += seconds * 1000;
    },
  };
}

const SMALL_LIMITS = {
  login: { maxEvents: 2, windowSeconds: 100 },
  passwordResetRequest: { maxEvents: 2, windowSeconds: 100 },
  passwordResetConsume: { maxEvents: 2, windowSeconds: 100 },
  invitationAccept: { maxEvents: 2, windowSeconds: 100 },
};

describe("CLIENT_IP_THROTTLE_LIMITS", () => {
  it("states the limit of each throttled action", () => {
    expect(CLIENT_IP_THROTTLE_LIMITS).toEqual({
      login: { maxEvents: 30, windowSeconds: 900 },
      passwordResetRequest: { maxEvents: 10, windowSeconds: 3600 },
      passwordResetConsume: { maxEvents: 10, windowSeconds: 3600 },
      invitationAccept: { maxEvents: 10, windowSeconds: 3600 },
    });
  });
});

describe("throttleKeyForIp", () => {
  it("keeps an IPv4 address as is", () => {
    expect(throttleKeyForIp("192.0.2.1")).toBe("192.0.2.1");
  });

  it("maps an IPv4-mapped IPv6 address to its IPv4 address", () => {
    expect(throttleKeyForIp("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(throttleKeyForIp("::ffff:c000:201")).toBe("192.0.2.1");
  });

  it("groups IPv6 addresses by their /64 prefix", () => {
    expect(throttleKeyForIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(throttleKeyForIp("2001:db8:1:2::1"));
    expect(throttleKeyForIp("2001:DB8:1:2:0:0:0:9")).toBe(throttleKeyForIp("2001:db8:1:2::9"));
    expect(throttleKeyForIp("2001:db8:1:2::1")).not.toBe(throttleKeyForIp("2001:db8:1:3::1"));
  });

  it("does not confuse an IPv6 prefix with an IPv4 address", () => {
    expect(throttleKeyForIp("::1")).toBe("0:0:0:0::/64");
  });
});

describe("createClientIpThrottle", () => {
  it("refuses the N+1-th event with the seconds until the oldest one expires, then allows again", () => {
    const clock = makeClock();
    const throttle = createClientIpThrottle({ now: clock.now, limits: SMALL_LIMITS });

    expect(throttle.retryAfterSeconds("login", "192.0.2.1")).toBeNull();
    throttle.record("login", "192.0.2.1");
    clock.advanceSeconds(10);
    throttle.record("login", "192.0.2.1");
    expect(throttle.retryAfterSeconds("login", "192.0.2.1")).toBe(90);

    clock.advanceSeconds(50);
    expect(throttle.retryAfterSeconds("login", "192.0.2.1")).toBe(40);

    clock.advanceSeconds(40);
    // The first event has left the window, the second has not.
    expect(throttle.retryAfterSeconds("login", "192.0.2.1")).toBeNull();
    throttle.record("login", "192.0.2.1");
    expect(throttle.retryAfterSeconds("login", "192.0.2.1")).toBe(10);

    clock.advanceSeconds(10);
    expect(throttle.retryAfterSeconds("login", "192.0.2.1")).toBeNull();
  });

  it("rounds a fractional remainder up to a whole second of at least 1", () => {
    let nowMs = 0;
    const throttle = createClientIpThrottle({ now: () => nowMs, limits: SMALL_LIMITS });
    throttle.record("login", "192.0.2.1");
    throttle.record("login", "192.0.2.1");
    nowMs = 99_900;
    expect(throttle.retryAfterSeconds("login", "192.0.2.1")).toBe(1);
  });

  it("is under the limit until the limit is reached", () => {
    const throttle = createClientIpThrottle({ now: makeClock().now, limits: SMALL_LIMITS });
    throttle.record("login", "192.0.2.1");
    expect(throttle.retryAfterSeconds("login", "192.0.2.1")).toBeNull();
  });

  it("keeps the four actions' counters separate", () => {
    const throttle = createClientIpThrottle({ now: makeClock().now, limits: SMALL_LIMITS });
    const actions: ThrottledAction[] = ["login", "passwordResetRequest", "passwordResetConsume", "invitationAccept"];
    for (const action of actions) {
      throttle.record(action, "192.0.2.1");
      throttle.record(action, "192.0.2.1");
      for (const other of actions) {
        const expected = actions.indexOf(other) <= actions.indexOf(action) ? 100 : null;
        expect(throttle.retryAfterSeconds(other, "192.0.2.1")).toBe(expected);
      }
    }
  });

  it("shares a counter within an IPv6 /64 and between a mapped and plain IPv4, but not across them", () => {
    const throttle = createClientIpThrottle({ now: makeClock().now, limits: SMALL_LIMITS });
    throttle.record("login", "2001:db8:1:2::1");
    throttle.record("login", "2001:db8:1:2:ffff::7");
    expect(throttle.retryAfterSeconds("login", "2001:db8:1:2::99")).toBe(100);
    expect(throttle.retryAfterSeconds("login", "2001:db8:1:3::1")).toBeNull();

    throttle.record("login", "::ffff:192.0.2.1");
    throttle.record("login", "192.0.2.1");
    expect(throttle.retryAfterSeconds("login", "192.0.2.1")).toBe(100);
    expect(throttle.retryAfterSeconds("login", "::ffff:192.0.2.1")).toBe(100);
    expect(throttle.retryAfterSeconds("login", "192.0.2.2")).toBeNull();
  });

  it("evicts a key whose events all expired before the least recently recorded live key", () => {
    const clock = makeClock();
    // Different windows per action, so the expired key is not also the least recently recorded one.
    const throttle = createClientIpThrottle({
      now: clock.now,
      maxKeys: 2,
      limits: {
        ...SMALL_LIMITS,
        login: { maxEvents: 1, windowSeconds: 100 },
        passwordResetRequest: { maxEvents: 1, windowSeconds: 1000 },
      },
    });
    throttle.record("passwordResetRequest", "192.0.2.1");
    clock.advanceSeconds(10);
    throttle.record("login", "192.0.2.2");
    clock.advanceSeconds(100);
    // The login key expired; the reset key is live but recorded earlier. Plain least-recently-recorded
    // eviction would drop the reset key; the expired-first sweep must drop the login key instead.
    throttle.record("passwordResetConsume", "192.0.2.3");

    expect(throttle.retryAfterSeconds("passwordResetRequest", "192.0.2.1")).toBe(890);
    expect(throttle.retryAfterSeconds("passwordResetConsume", "192.0.2.3")).toBeNull();
    throttle.record("passwordResetConsume", "192.0.2.3");
    expect(throttle.retryAfterSeconds("passwordResetConsume", "192.0.2.3")).toBe(100);
  });

  it("evicts the least recently recorded live key when no key has expired", () => {
    const clock = makeClock();
    const throttle = createClientIpThrottle({ now: clock.now, maxKeys: 2, limits: SMALL_LIMITS });
    throttle.record("login", "192.0.2.1");
    throttle.record("login", "192.0.2.1");
    clock.advanceSeconds(1);
    throttle.record("login", "192.0.2.2");
    throttle.record("login", "192.0.2.2");
    clock.advanceSeconds(1);
    // Re-recording .1 makes .2 the least recently recorded key.
    throttle.record("login", "192.0.2.1");
    throttle.record("login", "192.0.2.3");
    throttle.record("login", "192.0.2.3");

    expect(throttle.retryAfterSeconds("login", "192.0.2.1")).toBe(98);
    expect(throttle.retryAfterSeconds("login", "192.0.2.2")).toBeNull();
    expect(throttle.retryAfterSeconds("login", "192.0.2.3")).toBe(100);
  });

  it("counts keys of every action toward maxKeys and evicts the oldest across actions", () => {
    const clock = makeClock();
    const throttle = createClientIpThrottle({ now: clock.now, maxKeys: 2, limits: SMALL_LIMITS });
    throttle.record("login", "192.0.2.1");
    throttle.record("login", "192.0.2.1");
    clock.advanceSeconds(1);
    throttle.record("passwordResetRequest", "192.0.2.1");
    throttle.record("passwordResetRequest", "192.0.2.1");
    clock.advanceSeconds(1);
    throttle.record("passwordResetConsume", "192.0.2.1");

    expect(throttle.retryAfterSeconds("login", "192.0.2.1")).toBeNull();
    expect(throttle.retryAfterSeconds("passwordResetRequest", "192.0.2.1")).toBe(99);
  });

  it("stops counting an expired key toward maxKeys once it is read", () => {
    const clock = makeClock();
    const throttle = createClientIpThrottle({ now: clock.now, maxKeys: 2, limits: SMALL_LIMITS });
    throttle.record("login", "192.0.2.1");
    clock.advanceSeconds(100);
    expect(throttle.retryAfterSeconds("login", "192.0.2.1")).toBeNull();
    // Two live keys fit in maxKeys 2 only if the pruned key freed its slot; a leaked slot would evict .2.
    throttle.record("login", "192.0.2.2");
    throttle.record("login", "192.0.2.2");
    throttle.record("login", "192.0.2.3");
    expect(throttle.retryAfterSeconds("login", "192.0.2.2")).toBe(100);
  });
});

describe("tryAcquire", () => {
  it("counts each granted attempt at once, so attempts still in flight hold the window", () => {
    const throttle = createClientIpThrottle({ now: makeClock().now, limits: SMALL_LIMITS });
    expect(throttle.tryAcquire("login", "192.0.2.1").granted).toBe(true);
    expect(throttle.tryAcquire("login", "192.0.2.1").granted).toBe(true);
    expect(throttle.tryAcquire("login", "192.0.2.1")).toEqual({ granted: false, retryAfterSeconds: 100 });
    expect(throttle.retryAfterSeconds("login", "192.0.2.1")).toBe(100);
    expect(throttle.tryAcquire("passwordResetRequest", "192.0.2.1").granted).toBe(true);
  });

  it("uncounts a released attempt exactly once", () => {
    const throttle = createClientIpThrottle({ now: makeClock().now, limits: SMALL_LIMITS });
    const first = throttle.tryAcquire("login", "192.0.2.1");
    throttle.tryAcquire("login", "192.0.2.1");
    if (!first.granted) throw new Error("expected the first attempt to be granted");
    first.reservation.release();
    first.reservation.release();
    expect(throttle.retryAfterSeconds("login", "192.0.2.1")).toBeNull();
    expect(throttle.tryAcquire("login", "192.0.2.1").granted).toBe(true);
    expect(throttle.tryAcquire("login", "192.0.2.1").granted).toBe(false);
  });

  it("frees the key's maxKeys slot when its only event is released", () => {
    const throttle = createClientIpThrottle({ now: makeClock().now, maxKeys: 2, limits: SMALL_LIMITS });
    const acquisition = throttle.tryAcquire("login", "192.0.2.1");
    if (!acquisition.granted) throw new Error("expected the attempt to be granted");
    acquisition.reservation.release();
    throttle.record("login", "192.0.2.2");
    throttle.record("login", "192.0.2.2");
    throttle.record("login", "192.0.2.3");
    expect(throttle.retryAfterSeconds("login", "192.0.2.2")).toBe(100);
  });

  it("does not uncount a later event once the reserved one expired", () => {
    const clock = makeClock();
    const throttle = createClientIpThrottle({ now: clock.now, limits: SMALL_LIMITS });
    const stale = throttle.tryAcquire("login", "192.0.2.1");
    if (!stale.granted) throw new Error("expected the attempt to be granted");
    clock.advanceSeconds(100);
    throttle.record("login", "192.0.2.1");
    stale.reservation.release();
    throttle.record("login", "192.0.2.1");
    expect(throttle.retryAfterSeconds("login", "192.0.2.1")).toBe(100);
  });
});
