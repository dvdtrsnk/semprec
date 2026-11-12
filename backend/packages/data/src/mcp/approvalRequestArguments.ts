/**
 * The argument values of an MCP approval request as its owner sees them in the detail of one
 * request (issue #2021). Every other client-facing view reduces the payload to its argument names
 * (`approvalRequestsQueue.ts`, `safeSummary`); this is the one place the values leave the server,
 * so they are redacted and bounded first. The decision, with the key list, the bounds and the drop order,
 * is recorded in `docs/adr/2026-11-12-mcp-argument-values-leave-the-server-only-in-the-owners-request-detail.md`.
 */

/** The value that replaces the value of an argument whose key looks like a credential. */
const REDACTED_VALUE = "[redacted]";

/** A key that contains one of these, in any letter case and at any depth, has its value redacted. */
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

/** The longest string value that is returned whole, in UTF-16 code units (`String.prototype.length`). */
const MAX_STRING_LENGTH = 2000;

/** The most the JSON text of the returned `arguments` may take, in UTF-8 bytes. */
const MAX_ARGUMENTS_BYTES = 16 * 1024;

/**
 * The deepest nesting of a value that is walked. A byte cap does not bound the depth of a document,
 * and the walk is recursive, so a value nested deeper is replaced by `null` instead of being walked.
 */
const MAX_DEPTH = 32;

export interface ApprovalRequestArgumentValues {
  arguments: Record<string, unknown>;
  /** `true` when a string was shortened, a value was cut for its depth, or an entry did not fit the byte cap. */
  argumentsTruncated: boolean;
}

function isCredentialKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return CREDENTIAL_KEY_PARTS.some((part) => lowered.includes(part));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The UTF-8 size of the JSON text of `value`. */
function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** `text` cut to `MAX_STRING_LENGTH` code units, without a lone high surrogate at the cut. */
function shortenString(text: string): string {
  const cut = text.slice(0, MAX_STRING_LENGTH);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * `value` with the value of every credential-looking key replaced, every string bounded and nothing
 * nested deeper than `MAX_DEPTH`. Sets `state.truncated` for a string it shortened and a value it
 * replaced for its depth. A value that is not JSON (`undefined`, a function, a bigint) becomes `null`.
 */
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
 * `value`, or the part of it whose JSON text takes at most `budget` bytes; `undefined` when not even
 * an empty container or the scalar fits. Sets `state.truncated` for everything dropped.
 * - An array keeps its leading elements and stops at the first one that does not fit whole; that
 *   element is kept in part when it is a container that fits in part, and no element follows it.
 * - An object keeps, in its own order, first every entry that fits whole and then, in the room that
 *   is left, as much of each remaining container entry as fits. A large entry therefore does not
 *   crowd out the small entries after it, such as a recipient or a subject after a long body.
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
 * The argument values of an MCP approval request (`payload.args`) as they may be shown to the owner
 * in the detail of that one request:
 * - the value of every argument whose key, at any depth, contains `password`, `secret`, `token`,
 *   `apikey`, `api_key`, `authorization`, `cookie` or `credential` in any letter case is replaced by
 *   the string `[redacted]`, whatever its type; the elements of an array have no key and are walked;
 * - a string value longer than 2,000 characters is cut to 2,000 characters, as counted by `length`;
 * - a value nested deeper than 32 levels is replaced by `null`;
 * - the JSON text of the returned `arguments` takes at most 16 KiB (16,384 UTF-8 bytes): entries that
 *   do not fit are dropped, in the way `fitToBudget` describes.
 * `argumentsTruncated` is `true` whenever a string was shortened or a value was replaced or dropped
 * for its depth or the byte cap. A redacted value is not a truncation.
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
