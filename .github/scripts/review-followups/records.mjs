/**
 * The finding record and the harvest issue's data block of the review follow-ups
 * pipeline (docs/adr/2026-09-26-merged-review-findings-become-proposed-follow-up-issues.md).
 *
 * A finding record is one open finding of a merged pull request, as the pipeline passes
 * it between its steps. The daily harvest writes the records it selected into a data
 * block at the end of the harvest issue; the triage `prepare` step reads them back.
 * An issue body is editable by anyone with write access, so `parseHarvestBlock`
 * validates everything it reads, and `renderHarvestBlock` refuses to write a block that
 * `parseHarvestBlock` would reject.
 *
 * The block is the marker line, then a fenced JSON code block:
 *
 *   <!-- crb-followup-data:v1 -->
 *   ```json
 *   { "version": 1, "prs": [...], "findings": [...] }
 *   ```
 *
 * Every `<` in the JSON is written as `\u003c` (a JSON unicode escape), so text
 * quoted in a finding — such as another marker — can never form an HTML comment
 * inside the block.
 *
 * Zero dependencies; this module only exports functions and performs no I/O.
 */

const DATA_MARKER = "<!-- crb-followup-data:v1 -->";
const FENCE_OPEN = "```json";
const FENCE_CLOSE = "```";

const SEVERITIES = ["critical", "high", "medium", "low"];
const MAX_DESCRIPTION = 300;
const MAX_REPLIES = 3;
const MAX_EXCERPT = 200;

const HEX10 = /^[0-9a-f]{10}$/;
const SHA = /^[0-9a-f]{40}$/;
const DIGITS = /^[0-9]+$/;

/** Length in Unicode code points, the unit the bot clips its text in. */
function charLength(text) {
  return Array.from(text).length;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isSha(value) {
  return typeof value === "string" && (value === "" || SHA.test(value));
}

function validateReply(reply, index) {
  const field = `replies[${index}]`;
  if (!isPlainObject(reply)) {
    throw new Error(`finding record field "${field}" must be an object`);
  }
  if (!isNonEmptyString(reply.author)) {
    throw new Error(`finding record field "${field}.author" must be a non-empty string`);
  }
  if (typeof reply.excerpt !== "string" || charLength(reply.excerpt) > MAX_EXCERPT) {
    throw new Error(`finding record field "${field}.excerpt" must be a string of at most ${MAX_EXCERPT} characters`);
  }
  for (const name of Object.keys(reply)) {
    if (name !== "author" && name !== "excerpt") {
      throw new Error(`finding record field "${field}" has unexpected field "${name}"`);
    }
  }
}

/** Each field of a finding record, in the order it is checked, with its rule. */
const RECORD_FIELDS = [
  ["pr", "a positive integer", isPositiveInteger],
  ["key", "ten lowercase hex characters", (v) => typeof v === "string" && HEX10.test(v)],
  ["severity", `one of ${SEVERITIES.join(", ")}`, (v) => SEVERITIES.includes(v)],
  ["category", "a non-empty string", isNonEmptyString],
  ["path", "a non-empty string", isNonEmptyString],
  ["line", "an integer >= 0", isNonNegativeInteger],
  ["anchor", 'ten lowercase hex characters or ""', (v) => typeof v === "string" && (v === "" || HEX10.test(v))],
  [
    "description",
    `a string of at most ${MAX_DESCRIPTION} characters`,
    (v) => typeof v === "string" && charLength(v) <= MAX_DESCRIPTION,
  ],
  ["descriptionTruncated", "a boolean", (v) => typeof v === "boolean"],
  ["discussionId", 'a string of digits or ""', (v) => typeof v === "string" && (v === "" || DIGITS.test(v))],
  ["threadResolved", "a boolean", (v) => typeof v === "boolean"],
  [
    "replies",
    `an array of at most ${MAX_REPLIES} { author, excerpt } objects`,
    (v) => Array.isArray(v) && v.length <= MAX_REPLIES,
  ],
  ["pathExists", "a boolean", (v) => typeof v === "boolean"],
  ["touchedAfterLastSeen", "a boolean or null", (v) => v === null || typeof v === "boolean"],
  ["laterPrsTouchingPath", "an integer >= 0", isNonNegativeInteger],
  ["firstSeenSha", 'forty lowercase hex characters or ""', isSha],
  ["lastSeenSha", 'forty lowercase hex characters or ""', isSha],
];

const RECORD_FIELD_NAMES = new Set(RECORD_FIELDS.map(([name]) => name));

/**
 * Returns `value` if it is a finding record; otherwise throws an Error whose message
 * names the first offending field.
 */
export function validateFindingRecord(value) {
  if (!isPlainObject(value)) {
    throw new Error("finding record must be an object");
  }
  for (const [name, expected, isValid] of RECORD_FIELDS) {
    if (!Object.hasOwn(value, name)) {
      throw new Error(`finding record field "${name}" is missing`);
    }
    if (!isValid(value[name])) {
      throw new Error(`finding record field "${name}" must be ${expected}`);
    }
  }
  value.replies.forEach(validateReply);
  for (const name of Object.keys(value)) {
    if (!RECORD_FIELD_NAMES.has(name)) {
      throw new Error(`finding record has unexpected field "${name}"`);
    }
  }
  return value;
}

/** Throws unless `data` is exactly `{ prs, findings }` satisfying the block's constraints. */
function validateHarvestData(data) {
  if (!isPlainObject(data)) {
    throw new Error("harvest data must be an object");
  }
  for (const name of Object.keys(data)) {
    if (name !== "prs" && name !== "findings") {
      throw new Error(`harvest data has unexpected field "${name}"`);
    }
  }
  const { prs, findings } = data;
  if (!Array.isArray(prs) || prs.length === 0) {
    throw new Error('harvest data field "prs" must be a non-empty array');
  }
  prs.forEach((pr, index) => {
    if (!isPositiveInteger(pr)) {
      throw new Error(`harvest data field "prs[${index}]" must be a positive integer`);
    }
    if (index > 0 && pr <= prs[index - 1]) {
      throw new Error('harvest data field "prs" must be strictly ascending, without duplicates');
    }
  });
  if (!Array.isArray(findings)) {
    throw new Error('harvest data field "findings" must be an array');
  }
  const prSet = new Set(prs);
  const seen = new Set();
  findings.forEach((finding, index) => {
    try {
      validateFindingRecord(finding);
    } catch (error) {
      throw new Error(`harvest data field "findings[${index}]": ${error.message}`, {
        cause: error,
      });
    }
    if (!prSet.has(finding.pr)) {
      throw new Error(`harvest data field "findings[${index}]" has pr ${finding.pr}, which is not in "prs"`);
    }
    const identity = `${finding.pr}:${finding.key}`;
    if (seen.has(identity)) {
      throw new Error(`harvest data field "findings[${index}]" repeats pr ${finding.pr} key ${finding.key}`);
    }
    seen.add(identity);
  });
}

/**
 * Renders the harvest issue's data block for `{ prs, findings }`, ending in a newline.
 * Throws if the input violates any constraint `parseHarvestBlock` checks.
 */
export function renderHarvestBlock(data) {
  validateHarvestData(data);
  const json = JSON.stringify({ version: 1, prs: data.prs, findings: data.findings }, null, 2).replaceAll(
    "<",
    "\\u003c",
  );
  return `${DATA_MARKER}\n${FENCE_OPEN}\n${json}\n${FENCE_CLOSE}\n`;
}

/**
 * Reads the data block out of a whole harvest issue body and returns `{ prs, findings }`.
 * Throws when the marker is missing, appears more than once or not on a line of its
 * own, the fence is missing or unclosed, the JSON does not parse, `version` is not 1,
 * or any constraint on `prs` and `findings` fails.
 */
export function parseHarvestBlock(body) {
  if (typeof body !== "string") {
    throw new Error("harvest issue body must be a string");
  }
  const occurrences = body.split(DATA_MARKER).length - 1;
  if (occurrences === 0) {
    throw new Error(`harvest issue body has no ${DATA_MARKER} marker`);
  }
  if (occurrences > 1) {
    throw new Error(`harvest issue body has ${occurrences} ${DATA_MARKER} markers, expected one`);
  }
  const lines = body.split(/\r?\n/);
  const markerIndex = lines.indexOf(DATA_MARKER);
  if (markerIndex === -1) {
    throw new Error(`harvest issue body has the ${DATA_MARKER} marker, but not on a line of its own`);
  }
  if (lines[markerIndex + 1] !== FENCE_OPEN) {
    throw new Error(`the ${DATA_MARKER} marker is not followed by a ${FENCE_OPEN} fence line`);
  }
  const closeIndex = lines.indexOf(FENCE_CLOSE, markerIndex + 2);
  if (closeIndex === -1) {
    throw new Error("the harvest data fence is never closed");
  }
  const json = lines.slice(markerIndex + 2, closeIndex).join("\n");

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    throw new Error(`the harvest data block is not valid JSON: ${error.message}`, {
      cause: error,
    });
  }

  if (!isPlainObject(parsed)) {
    throw new Error("the harvest data block must hold a JSON object");
  }
  if (parsed.version !== 1) {
    throw new Error('the harvest data block field "version" must be 1');
  }
  const { version: _version, ...data } = parsed;
  validateHarvestData(data);
  return data;
}
