/**
 * Owner-only argument values for the detail of one MCP approval request. Every other client-facing view carries
 * argument names only, so this is the one place values leave the server and they are redacted and bounded first.
 * See docs/architecture/agents-approvals-and-ai.md#what-a-request-shows.
 */

const REDACTED_VALUE = "[redacted]";

/** Matched in any letter case at any depth. */
const CREDENTIAL_KEY_PARTS = [
  "password",
  "secret",
  "token",
  "apikey",
  "api_key",
  "authorization",
  "cookie",
  "credential",
] as const;

/** In UTF-16 code units. */
const MAX_STRING_LENGTH = 2000;

/** In UTF-8 bytes. */
const MAX_ARGUMENTS_BYTES = 16 * 1024;

/** The walk is recursive and a byte cap does not bound depth, so deeper values become `null`. */
const MAX_DEPTH = 32;

export interface ApprovalRequestArgumentValues {
  arguments: Record<string, unknown>;
  argumentsTruncated: boolean;
}

function isCredentialKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return CREDENTIAL_KEY_PARTS.some((part) => lowered.includes(part));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Never leaves a lone high surrogate at the cut. */
function shortenString(text: string): string {
  const cut = text.slice(0, MAX_STRING_LENGTH);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Non-JSON values (`undefined`, functions, bigints) become `null`. */
function sanitize(value: unknown, depth: number, state: { truncated: boolean }): unknown {
  if (typeof value === "string") {
    if (value.length <= MAX_STRING_LENGTH) return value;
    state.truncated = true;
    return shortenString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (!Array.isArray(value) && !isPlainRecord(value)) return null;
  if (depth >= MAX_DEPTH) {
    state.truncated = true;
    return null;
  }
  if (Array.isArray(value)) return value.map((element) => sanitize(element, depth + 1, state));
  // `Object.fromEntries` defines own properties, so a key named `__proto__` stays a key.
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      isCredentialKey(key) ? REDACTED_VALUE : sanitize(child, depth + 1, state),
    ]),
  );
}

/**
 * `undefined` when not even an empty container or the scalar fits.
 * - An array keeps a prefix; the first element that does not fit whole may be kept in part, and nothing follows.
 * - An object first keeps every entry that fits whole, then fills the rest with parts of remaining containers, so
 *   a large entry (a long body) does not crowd out small ones after it (recipient, subject).
 */
function fitToBudget(value: unknown, budget: number, state: { truncated: boolean }): unknown {
  if (jsonBytes(value) <= budget) return value;
  state.truncated = true;
  // Two bytes for the brackets or braces; every element or entry but the first costs one more for the comma.
  let remaining = budget - 2;
  if (remaining < 0) return undefined;
  if (Array.isArray(value)) {
    const kept: unknown[] = [];
    for (const element of value) {
      const fitted = fitToBudget(element, remaining - (kept.length > 0 ? 1 : 0), state);
      if (fitted === undefined) break;
      kept.push(fitted);
      remaining -= jsonBytes(fitted) + (kept.length > 1 ? 1 : 0);
      // An element kept in part ends the prefix: the elements after it are dropped, not squeezed into the leftover room.
      if (fitted !== element) break;
    }
    return kept;
  }
  if (!isPlainRecord(value)) return undefined;
  const entries = Object.entries(value);
  // An entry costs its key with the quotes, the colon, its value, and the comma unless it is the first one kept.
  const slots: Array<[string, unknown] | undefined> = entries.map(() => undefined);
  let count = 0;
  entries.forEach(([key, child], index) => {
    const cost = jsonBytes(key) + 1 + jsonBytes(child) + (count > 0 ? 1 : 0);
    if (cost > remaining) return;
    slots[index] = [key, child];
    remaining -= cost;
    count += 1;
  });
  entries.forEach(([key, child], index) => {
    if (slots[index] !== undefined || typeof child !== "object" || child === null) return;
    const overhead = jsonBytes(key) + 1 + (count > 0 ? 1 : 0);
    if (overhead > remaining) return;
    const fitted = fitToBudget(child, remaining - overhead, state);
    if (fitted === undefined) return;
    slots[index] = [key, fitted];
    remaining -= overhead + jsonBytes(fitted);
    count += 1;
  });
  return Object.fromEntries(slots.filter((slot) => slot !== undefined));
}

/**
 * Redacts credential-looking keys (an array's elements have no key and are walked), cuts strings at 2,000
 * characters, replaces values deeper than 32 levels with `null`, and caps the JSON at 16 KiB (`fitToBudget`).
 * A redaction is not a truncation.
 */
export function toApprovalRequestArgumentValues(args: Record<string, unknown>): ApprovalRequestArgumentValues {
  const state = { truncated: false };
  const sanitized = sanitize(args, 0, state);
  // `args` is a record, so the sanitized value is an object, and the budget is far above an empty one.
  const fitted = fitToBudget(sanitized, MAX_ARGUMENTS_BYTES, state);
  return {
    arguments: isPlainRecord(fitted) ? fitted : {},
    argumentsTruncated: state.truncated,
  };
}
