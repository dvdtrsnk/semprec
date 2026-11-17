/**
 * Reads the code-review bot's review memory from a pull request's comments.
 *
 * The bot (`dvdtrsnk/code-review-bot`, `scripts/review/memory_store.py`) remembers its
 * findings on a pull request in one issue comment: a visible "Review memory" table whose
 * last line is the marker `<!-- crb-memory:v1:z:<payload> -->`. The comment is updated in
 * place, but a failed load makes the bot save a second note, so a pull request can carry
 * more than one; like the bot, this reader takes the newest one.
 *
 *   - Payload: `base64.b64encode(zlib.compress(json_utf8, 9))` — the standard base64
 *     alphabet (`+`, `/`, `=` padding) with no line breaks, around zlib-wrapped deflate
 *     (RFC 1950), so it inflates with `zlib.inflateSync`, not `inflateRawSync`. It is the
 *     text between the prefix and the next `-->`, trimmed.
 *   - Authors: only `github-actions[bot]` (the Actions review workflow) and
 *     `bb-agent-relay[bot]` (Relay's review pipeline) are trusted. The repository is
 *     public, so anyone else can post a comment containing the prefix.
 *   - JSON: `version`, `project_id`, `pr_number`, `head_sha`, `base_sha`, `verdict_*`,
 *     `findings`, `events` and `notes`. Memories written before the bot renamed the field
 *     carry the pull request number as `mr_iid` instead of `pr_number`. Each finding has
 *     `key` (ten lowercase hex characters), `path`, `line` (integer), `severity`
 *     (`critical`, `high`, `medium`, `low`), `category`, `description` (clipped to 300
 *     characters), `anchor`, `status` (`open`, `resolved`, `wontfix`, `fixed`),
 *     `first_seen_sha`, `last_seen_sha` (full SHAs, or ""), `runs`, `discussion_id` and
 *     `note`.
 *
 * The bot's own reader silently skips malformed entries. This one deliberately does not:
 * a trusted memory that cannot be decoded, or does not have this shape, throws an Error
 * naming the stage or field, so the harvest fails instead of losing findings, and a
 * format change in the bot surfaces. Fields the harvest does not use (`runs`, `note`,
 * `events`, `notes`, `verdict_*` …) are ignored whatever their shape.
 */

import { inflateSync } from "node:zlib";

export const TRUSTED_REVIEW_BOT_LOGINS = Object.freeze(["github-actions[bot]", "bb-agent-relay[bot]"]);

export const MEMORY_MARKER_PREFIX = "<!-- crb-memory:v1:z:";

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const KEY_PATTERN = /^[0-9a-f]{10}$/;
const SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const STATUSES = new Set(["open", "resolved", "wontfix", "fixed"]);

/**
 * Returns the newest comment (by `createdAt`, ties broken by the higher `id`) that a
 * trusted bot wrote and that contains the memory prefix, or `null` when there is none.
 *
 * A comment whose `body` is not a string (GitHub returns `null` for a deleted or minimized
 * comment) is skipped like one without the prefix.
 *
 * @param {{ id: number, author: string, createdAt: string, body: string | null }[]} comments
 */
export function selectMemoryComment(comments) {
  let newest = null;
  for (const comment of comments) {
    if (!TRUSTED_REVIEW_BOT_LOGINS.includes(comment.author)) continue;
    if (typeof comment.body !== "string" || !comment.body.includes(MEMORY_MARKER_PREFIX)) continue;
    if (newest === null || isNewer(comment, newest)) newest = comment;
  }
  return newest;
}

function isNewer(a, b) {
  const aTime = Date.parse(a.createdAt);
  const bTime = Date.parse(b.createdAt);
  if (aTime !== bTime) return aTime > bTime;
  return a.id > b.id;
}

/**
 * Extracts the payload from a memory comment body and decodes it to a JSON value.
 * Throws an Error naming the stage that failed: extract, base64, inflate, utf-8 or json.
 *
 * @param {string} body
 */
export function decodeMemory(body) {
  const start = body.indexOf(MEMORY_MARKER_PREFIX);
  if (start === -1) {
    throw new Error(`review memory extract: the body does not contain ${MEMORY_MARKER_PREFIX}`);
  }
  const rest = body.slice(start + MEMORY_MARKER_PREFIX.length);
  const end = rest.indexOf("-->");
  if (end === -1) {
    throw new Error("review memory extract: the marker is not closed with -->");
  }
  const payload = rest.slice(0, end).trim();

  if (payload === "" || payload.length % 4 !== 0 || !BASE64_PATTERN.test(payload)) {
    throw new Error("review memory base64: the payload is not standard base64");
  }
  const compressed = Buffer.from(payload, "base64");

  let bytes;
  try {
    bytes = inflateSync(compressed);
  } catch (err) {
    throw new Error(`review memory inflate: the payload is not zlib data (${err.message})`, { cause: err });
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (err) {
    throw new Error(`review memory utf-8: the inflated payload is not valid UTF-8 (${err.message})`, { cause: err });
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`review memory json: the inflated payload is not JSON (${err.message})`, { cause: err });
  }
}

/**
 * Validates a decoded memory for pull request `prNumber` and returns its findings in
 * camelCase. Throws an Error naming the field that is missing or has the wrong shape.
 *
 * @param {unknown} value
 * @param {number} prNumber
 * @returns {{ findings: {
 *   key: string, path: string, line: number, severity: string, category: string,
 *   description: string, anchor: string, status: string, discussionId: string,
 *   firstSeenSha: string, lastSeenSha: string,
 * }[] }}
 */
export function parseMemory(value, prNumber) {
  if (!isPlainObject(value)) {
    throw new Error(`review memory of #${prNumber}: the decoded value is not an object`);
  }
  const memoryPr = "pr_number" in value ? value.pr_number : value.mr_iid;
  if (memoryPr !== prNumber) {
    throw new Error(
      `review memory of #${prNumber}: pr_number is ${JSON.stringify(memoryPr)}, expected ${prNumber}`,
    );
  }
  if (!Array.isArray(value.findings)) {
    throw new Error(`review memory of #${prNumber}: findings is not an array`);
  }
  const findings = value.findings.map((finding, index) =>
    parseFinding(finding, `review memory of #${prNumber}: findings[${index}]`),
  );
  return { findings };
}

function parseFinding(finding, where) {
  if (!isPlainObject(finding)) throw new Error(`${where} is not an object`);

  const fail = (field, expected) => {
    throw new Error(`${where}.${field} must be ${expected}, got ${JSON.stringify(finding[field])}`);
  };
  const string = (field) => {
    if (typeof finding[field] !== "string") fail(field, "a string");
    return finding[field];
  };

  const key = string("key");
  if (!KEY_PATTERN.test(key)) fail("key", "ten lowercase hex characters");
  const path = string("path");
  if (path === "") fail("path", "a non-empty string");
  if (!Number.isInteger(finding.line) || finding.line < 0) fail("line", "an integer >= 0");
  const severity = string("severity");
  if (!SEVERITIES.has(severity)) fail("severity", `one of ${[...SEVERITIES].join(", ")}`);
  const status = string("status");
  if (!STATUSES.has(status)) fail("status", `one of ${[...STATUSES].join(", ")}`);

  return {
    key,
    path,
    line: finding.line,
    severity,
    category: string("category"),
    description: string("description"),
    anchor: string("anchor"),
    status,
    discussionId: string("discussion_id"),
    firstSeenSha: string("first_seen_sha"),
    lastSeenSha: string("last_seen_sha"),
  };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
