import { isIPv4, isIPv6 } from "node:net";

/** The public pre-authentication actions that are throttled per client address (issue #1073). */
export type ThrottledAction = "login" | "passwordResetRequest" | "passwordResetConsume" | "invitationAccept";

export interface ClientIpThrottleLimit {
  /** Counted events one key may have inside the window before further attempts are refused. */
  maxEvents: number;
  windowSeconds: number;
}

/** Sliding-window limit per client address, for each throttled action. */
export const CLIENT_IP_THROTTLE_LIMITS: Record<ThrottledAction, ClientIpThrottleLimit> = {
  login: { maxEvents: 30, windowSeconds: 15 * 60 },
  passwordResetRequest: { maxEvents: 10, windowSeconds: 60 * 60 },
  passwordResetConsume: { maxEvents: 10, windowSeconds: 60 * 60 },
  invitationAccept: { maxEvents: 10, windowSeconds: 60 * 60 },
};

const THROTTLE_ACTIONS = Object.keys(CLIENT_IP_THROTTLE_LIMITS) as ThrottledAction[];

const DEFAULT_MAX_KEYS = 50_000;

/** Expands an IPv6 address into its eight 16-bit groups, or `null` when it is not well formed. */
function ipv6Groups(address: string): number[] | null {
  const withoutZone = address.split("%")[0] ?? address;
  let text = withoutZone;
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!isIPv4(tail)) return null;
    const octets = tail.split(".").map(Number);
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    text = `${text.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      groups.push(parseInt(group, 16));
    }
    return groups;
  };
  const head = parse(halves[0] ?? "");
  const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (head === null || rest === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...rest];
}

/**
 * The key a client address is throttled under: an IPv4 address as is, an IPv4-mapped IPv6 address
 * (`::ffff:a.b.c.d`) as its IPv4 address, and any other IPv6 address as its `/64` prefix, because
 * one host commonly holds a whole `/64` and would otherwise get a fresh budget per address.
 */
export function throttleKeyForIp(ip: string): string {
  if (!isIPv6(ip)) return ip;
  const groups = ipv6Groups(ip);
  if (groups === null) return ip;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

export interface ClientIpThrottleOptions {
  /** Clock in epoch milliseconds; injected by tests. */
  now?: () => number;
  /** Upper bound on distinct `(action, key)` pairs held at once. Defaults to 50,000. */
  maxKeys?: number;
  limits?: Partial<typeof CLIENT_IP_THROTTLE_LIMITS>;
}

export interface ClientIpThrottle {
  /** `null` while the address is under the action's limit; otherwise whole seconds (≥ 1) until the oldest counted event leaves the window. */
  retryAfterSeconds(action: ThrottledAction, ip: string): number | null;
  /** Counts one event for the address under the action. */
  record(action: ThrottledAction, ip: string): void;
  /**
   * Checks the limit and, when the address is under it, counts one event in the same synchronous
   * step, so concurrent requests cannot all pass the check before any of them is counted. The
   * returned reservation's `release` uncounts that event again, for an outcome that must not count.
   */
  tryAcquire(action: ThrottledAction, ip: string): ThrottleAcquisition;
}

/** An event counted by `tryAcquire`; `release` removes it, and is a no-op once it has expired, been evicted or been released. */
export interface ThrottleReservation {
  release(): void;
}

export type ThrottleAcquisition =
  { granted: true; reservation: ThrottleReservation } | { granted: false; retryAfterSeconds: number };

/**
 * A per-client-address sliding-window limiter for the public authentication routes. State lives in
 * this process's memory and is per `(action, key)` (see `throttleKeyForIp`). That is sound only
 * because production runs exactly one semprec-api process, so this instance sees every request; a
 * second process would give each its own budget. A restart clears every window.
 *
 * Expired events are pruned when a key is read or recorded. At `maxKeys`, recording a new key first
 * drops keys whose events have all expired, then the key recorded least recently.
 */
export function createClientIpThrottle(options: ClientIpThrottleOptions = {}): ClientIpThrottle {
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const limits = { ...CLIENT_IP_THROTTLE_LIMITS, ...options.limits };

  // One map per action. Releasing a reservation can remove a key's newest event without changing
  // its insertion order, so eviction compares the remaining timestamps of every key.
  const eventsByAction = new Map<ThrottledAction, Map<string, number[]>>(
    THROTTLE_ACTIONS.map((action) => [action, new Map<string, number[]>()]),
  );
  let keyCount = 0;

  function mapFor(action: ThrottledAction): Map<string, number[]> {
    const map = eventsByAction.get(action);
    if (!map) throw new Error(`unknown throttled action: ${action}`);
    return map;
  }

  function windowMs(action: ThrottledAction): number {
    return limits[action].windowSeconds * 1000;
  }

  /** Drops the events of `key` that left the window; removes the key when none remain. */
  function prune(action: ThrottledAction, key: string, events: number[], at: number): number[] {
    const cutoff = at - windowMs(action);
    let firstLive = 0;
    while (firstLive < events.length && events[firstLive]! <= cutoff) firstLive++;
    if (firstLive === events.length) {
      mapFor(action).delete(key);
      keyCount--;
      return [];
    }
    if (firstLive > 0) events.splice(0, firstLive);
    return events;
  }

  function makeRoom(at: number): void {
    if (keyCount < maxKeys) return;
    for (const action of THROTTLE_ACTIONS) {
      const map = mapFor(action);
      const cutoff = at - windowMs(action);
      for (const [key, events] of map) {
        if (events[events.length - 1]! > cutoff) continue;
        map.delete(key);
        keyCount--;
      }
    }
    if (keyCount < maxKeys) return;
    let oldest: { map: Map<string, number[]>; key: string; recordedAt: number } | null = null;
    for (const action of THROTTLE_ACTIONS) {
      const map = mapFor(action);
      for (const [key, events] of map) {
        const recordedAt = events[events.length - 1]!;
        if (oldest === null || recordedAt < oldest.recordedAt) oldest = { map, key, recordedAt };
      }
    }
    if (oldest) {
      oldest.map.delete(oldest.key);
      keyCount--;
    }
  }

  function retryAfterSeconds(action: ThrottledAction, ip: string): number | null {
    const key = throttleKeyForIp(ip);
    const stored = mapFor(action).get(key);
    if (!stored) return null;
    const at = now();
    const events = prune(action, key, stored, at);
    const { maxEvents } = limits[action];
    if (events.length < maxEvents) return null;
    const oldestCounted = events[events.length - maxEvents]!;
    return Math.max(1, Math.ceil((oldestCounted + windowMs(action) - at) / 1000));
  }

  /** Counts one event and returns the key's event array (kept by identity while the key lives) and its timestamp. */
  function recordEvent(action: ThrottledAction, ip: string): { key: string; events: number[]; at: number } {
    const key = throttleKeyForIp(ip);
    const map = mapFor(action);
    const at = now();
    const stored = map.get(key);
    const events = stored ? prune(action, key, stored, at) : [];
    if (events.length > 0) {
      // Re-inserted below, so the key moves to the back of the recency order.
      map.delete(key);
      keyCount--;
    } else {
      makeRoom(at);
    }
    events.push(at);
    // Only the newest `maxEvents` can ever matter to `retryAfterSeconds`.
    const { maxEvents } = limits[action];
    if (events.length > maxEvents) events.splice(0, events.length - maxEvents);
    map.set(key, events);
    keyCount++;
    return { key, events, at };
  }

  return {
    retryAfterSeconds,

    record(action, ip) {
      recordEvent(action, ip);
    },

    tryAcquire(action, ip) {
      const retryAfter = retryAfterSeconds(action, ip);
      if (retryAfter !== null) return { granted: false, retryAfterSeconds: retryAfter };
      const { key, events, at } = recordEvent(action, ip);
      let released = false;
      return {
        granted: true,
        reservation: {
          release() {
            if (released) return;
            released = true;
            const map = mapFor(action);
            // Identity, not key presence: once the key's events all expired or the key was evicted, a
            // later record starts a fresh array that does not hold this reservation's event.
            if (map.get(key) !== events) return;
            const index = events.lastIndexOf(at);
            if (index === -1) return;
            events.splice(index, 1);
            if (events.length === 0) {
              map.delete(key);
              keyCount--;
            }
          },
        },
      };
    },
  };
}
