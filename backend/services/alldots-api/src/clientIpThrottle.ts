import { isIPv4, isIPv6 } from "node:net";

/**
 * `mailboxCredentialVerification` (the password mailbox connect login check), `mailContentFetch` (a message body or an
 * attachment fetched from the mail provider on demand), `mailRemoteSearch` (a mail search that asks the providers),
 * `mailHistoryUpload` (a native client's claim or upload of IMAP history) and `mailSignalPreview` (a project's mail
 * signals matched against the whole mail index) are counted per user; the others are
 * public actions reachable without a session, counted per client address. `mailOauthCallback` is the provider's OAuth
 * redirect target, `calendarWebhook` a Google or Microsoft Graph calendar change notification and `mailWebhook` a
 * Microsoft Graph mail change notification.
 */
export type ThrottledAction =
  | "login"
  | "passwordResetRequest"
  | "passwordResetConsume"
  | "invitationAccept"
  | "mailboxCredentialVerification"
  | "mailContentFetch"
  | "mailRemoteSearch"
  | "mailHistoryUpload"
  | "mailSignalPreview"
  | "mailOauthCallback"
  | "calendarWebhook"
  | "mailWebhook";

export interface ClientIpThrottleLimit {
  maxEvents: number;
  windowSeconds: number;
}

/** Sliding-window limit of each action, per key (`throttleKey`). */
export const CLIENT_IP_THROTTLE_LIMITS: Record<ThrottledAction, ClientIpThrottleLimit> = {
  login: { maxEvents: 30, windowSeconds: 15 * 60 },
  passwordResetRequest: { maxEvents: 10, windowSeconds: 60 * 60 },
  passwordResetConsume: { maxEvents: 10, windowSeconds: 60 * 60 },
  invitationAccept: { maxEvents: 10, windowSeconds: 60 * 60 },
  mailboxCredentialVerification: { maxEvents: 10, windowSeconds: 15 * 60 },
  mailContentFetch: { maxEvents: 120, windowSeconds: 15 * 60 },
  mailRemoteSearch: { maxEvents: 30, windowSeconds: 15 * 60 },
  // 500 messages a request: a 15-minute window takes up to 300 000 messages of history.
  mailHistoryUpload: { maxEvents: 600, windowSeconds: 15 * 60 },
  // A setup screen previews as the user edits the signals; each preview scans the tenant's mail index.
  mailSignalPreview: { maxEvents: 120, windowSeconds: 15 * 60 },
  mailOauthCallback: { maxEvents: 30, windowSeconds: 15 * 60 },
  // A provider delivers every subscribed account's notifications from a few addresses, so the
  // budget is per minute and well above one user's edit rate.
  calendarWebhook: { maxEvents: 300, windowSeconds: 60 },
  // Same reasoning, with its own budget, so calendar notifications cannot starve mail ones.
  mailWebhook: { maxEvents: 300, windowSeconds: 60 },
};

const THROTTLE_ACTIONS = Object.keys(CLIENT_IP_THROTTLE_LIMITS) as ThrottledAction[];

const DEFAULT_MAX_KEYS = 50_000;

/** `null` when not well formed. */
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
 * An IPv4-mapped IPv6 address counts as its IPv4 address, and any other IPv6 address as its `/64`
 * prefix, because one host commonly holds a whole `/64` and would otherwise get a fresh budget per
 * address.
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

/** The actions keyed by the user id as is; every other action by client address via `throttleKeyForIp`. */
const PER_USER_ACTIONS: ReadonlySet<ThrottledAction> = new Set([
  "mailboxCredentialVerification",
  "mailContentFetch",
  "mailRemoteSearch",
  "mailHistoryUpload",
  "mailSignalPreview",
]);

function throttleKey(action: ThrottledAction, subject: string): string {
  return PER_USER_ACTIONS.has(action) ? subject : throttleKeyForIp(subject);
}

export interface ClientIpThrottleOptions {
  now?: () => number;
  /** Defaults to 50,000. */
  maxKeys?: number;
  limits?: Partial<typeof CLIENT_IP_THROTTLE_LIMITS>;
}

/** `subject` is the user id for the per-user actions, the client address otherwise. */
export interface ClientIpThrottle {
  /**
   * `null` while under the limit; otherwise whole seconds (>= 1) until the oldest counted event
   * leaves the window.
   */
  retryAfterSeconds(action: ThrottledAction, subject: string): number | null;
  record(action: ThrottledAction, subject: string): void;
  /**
   * Checks and counts in one synchronous step, so concurrent requests cannot all pass before any is
   * counted. `release` uncounts the event for an outcome that must not count.
   */
  tryAcquire(action: ThrottledAction, subject: string): ThrottleAcquisition;
}

/** `release` is a no-op once the event expired, was evicted or was released. */
export interface ThrottleReservation {
  release(): void;
}

export type ThrottleAcquisition =
  { granted: true; reservation: ThrottleReservation } | { granted: false; retryAfterSeconds: number };

/**
 * State lives in process memory per `(action, key)`. That is sound only because production runs
 * exactly one alldots-api process; a second process would give each its own budget. A restart
 * clears every window.
 *
 * Expired events are pruned when a key is read or recorded. At `maxKeys`, recording a new key first
 * drops fully expired keys, then the least recently recorded key.
 */
export function createClientIpThrottle(options: ClientIpThrottleOptions = {}): ClientIpThrottle {
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const limits = { ...CLIENT_IP_THROTTLE_LIMITS, ...options.limits };

  // Releasing a reservation can remove a key's newest event without changing its insertion order,
  // so eviction compares the remaining timestamps of every key.
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

  /** Removes the key when no events remain. */
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

  function retryAfterSeconds(action: ThrottledAction, subject: string): number | null {
    const key = throttleKey(action, subject);
    const stored = mapFor(action).get(key);
    if (!stored) return null;
    const at = now();
    const events = prune(action, key, stored, at);
    const { maxEvents } = limits[action];
    if (events.length < maxEvents) return null;
    const oldestCounted = events[events.length - maxEvents]!;
    return Math.max(1, Math.ceil((oldestCounted + windowMs(action) - at) / 1000));
  }

  /** The returned array is kept by identity while the key lives. */
  function recordEvent(action: ThrottledAction, subject: string): { key: string; events: number[]; at: number } {
    const key = throttleKey(action, subject);
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

    record(action, subject) {
      recordEvent(action, subject);
    },

    tryAcquire(action, subject) {
      const retryAfter = retryAfterSeconds(action, subject);
      if (retryAfter !== null) return { granted: false, retryAfterSeconds: retryAfter };
      const { key, events, at } = recordEvent(action, subject);
      let released = false;
      return {
        granted: true,
        reservation: {
          release() {
            if (released) return;
            released = true;
            const map = mapFor(action);
            // Identity, not presence: after expiry or eviction a later record starts a fresh array
            // without this reservation's event.
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
