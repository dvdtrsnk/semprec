/**
 * The triage input file of the review follow-ups pipeline
 * (docs/adr/2026-09-26-merged-review-findings-become-proposed-follow-up-issues.md).
 *
 * The triage workflow's `prepare` step writes this file into the run's worktree, so the
 * triage agent has everything it needs without touching GitHub; the `validate` and
 * `publish` steps read it back to check that the agent's proposal accounts for every
 * finding in it. The agent writes into the same worktree, so the file is a boundary:
 * `parseInputFile` validates everything it reads, and `renderInputFile` refuses to write
 * a file that `parseInputFile` would reject.
 *
 * The file is JSON with two-space indentation and a trailing newline:
 *
 *   {
 *     "version": 1,
 *     "harvestIssue": <positive integer>,
 *     "findings": [...],
 *     "prSummaries": [...],
 *     "openIssues": [...]
 *   }
 *
 * - `harvestIssue` is the number of the harvest issue being triaged.
 * - Each `findings` entry is a finding record (records.mjs, `validateFindingRecord`)
 *   plus exactly three more fields: `fullText` (the full inline comment text, string or
 *   null), `suggestedFix` (the bot's suggested fix, string or null) and `threadReplies`
 *   (an array of `{ author: non-empty string, body: string }`). No two entries share
 *   `(pr, key)`.
 * - `prSummaries` is an array of `{ pr: positive integer, body: string }`, each pull
 *   request's latest review summary, at most one per `pr`.
 * - `openIssues` is an array of `{ number: positive integer, title: string,
 *   labels: string[], touches: string }`, the open queued issues with their `## Touches`
 *   sections, without duplicate `number`.
 *
 * No object may carry a field not listed above.
 *
 * Zero dependencies; this module only exports functions and performs no I/O.
 */

import { validateFindingRecord } from "./records.mjs";

const TOP_LEVEL_FIELDS = ["version", "harvestIssue", "findings", "prSummaries", "openIssues"];
const ENTRY_EXTRA_FIELDS = ["fullText", "suggestedFix", "threadReplies"];

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isStringOrNull(value) {
  return value === null || typeof value === "string";
}

function fail(field, message) {
  throw new Error(`input file field "${field}" ${message}`);
}

/** Throws unless `value` is an object holding exactly the fields in `allowed`. */
function requireObject(value, field, allowed) {
  if (!isPlainObject(value)) {
    fail(field, "must be an object");
  }
  for (const name of allowed) {
    if (!Object.hasOwn(value, name)) {
      fail(`${field}.${name}`, "is missing");
    }
  }
  for (const name of Object.keys(value)) {
    if (!allowed.includes(name)) {
      fail(field, `has unexpected field "${name}"`);
    }
  }
}

function requireArray(value, field) {
  if (!Array.isArray(value)) {
    fail(field, "must be an array");
  }
}

function validateThreadReply(reply, field) {
  requireObject(reply, field, ["author", "body"]);
  if (!isNonEmptyString(reply.author)) {
    fail(`${field}.author`, "must be a non-empty string");
  }
  if (typeof reply.body !== "string") {
    fail(`${field}.body`, "must be a string");
  }
}

function validateFindingEntry(entry, field) {
  if (!isPlainObject(entry)) {
    fail(field, "must be an object");
  }
  for (const name of ENTRY_EXTRA_FIELDS) {
    if (!Object.hasOwn(entry, name)) {
      fail(`${field}.${name}`, "is missing");
    }
  }
  const { fullText, suggestedFix, threadReplies, ...record } = entry;
  try {
    validateFindingRecord(record);
  } catch (error) {
    throw new Error(`input file field "${field}": ${error.message}`, { cause: error });
  }
  if (!isStringOrNull(fullText)) {
    fail(`${field}.fullText`, "must be a string or null");
  }
  if (!isStringOrNull(suggestedFix)) {
    fail(`${field}.suggestedFix`, "must be a string or null");
  }
  requireArray(threadReplies, `${field}.threadReplies`);
  threadReplies.forEach((reply, index) => validateThreadReply(reply, `${field}.threadReplies[${index}]`));
}

function validatePrSummary(summary, field) {
  requireObject(summary, field, ["pr", "body"]);
  if (!isPositiveInteger(summary.pr)) {
    fail(`${field}.pr`, "must be a positive integer");
  }
  if (typeof summary.body !== "string") {
    fail(`${field}.body`, "must be a string");
  }
}

function validateOpenIssue(issue, field) {
  requireObject(issue, field, ["number", "title", "labels", "touches"]);
  if (!isPositiveInteger(issue.number)) {
    fail(`${field}.number`, "must be a positive integer");
  }
  if (typeof issue.title !== "string") {
    fail(`${field}.title`, "must be a string");
  }
  requireArray(issue.labels, `${field}.labels`);
  issue.labels.forEach((label, index) => {
    if (typeof label !== "string") {
      fail(`${field}.labels[${index}]`, "must be a string");
    }
  });
  if (typeof issue.touches !== "string") {
    fail(`${field}.touches`, "must be a string");
  }
}

/** Throws an Error naming the first offending field unless `input` is a valid input file. */
function validateInputFile(input) {
  if (!isPlainObject(input)) {
    throw new Error("the triage input file must hold a JSON object");
  }
  for (const name of TOP_LEVEL_FIELDS) {
    if (!Object.hasOwn(input, name)) {
      fail(name, "is missing");
    }
  }
  for (const name of Object.keys(input)) {
    if (!TOP_LEVEL_FIELDS.includes(name)) {
      throw new Error(`the triage input file has unexpected field "${name}"`);
    }
  }
  if (input.version !== 1) {
    fail("version", "must be 1");
  }
  if (!isPositiveInteger(input.harvestIssue)) {
    fail("harvestIssue", "must be a positive integer");
  }

  requireArray(input.findings, "findings");
  const findingIdentities = new Set();
  input.findings.forEach((entry, index) => {
    const field = `findings[${index}]`;
    validateFindingEntry(entry, field);
    const identity = `${entry.pr}:${entry.key}`;
    if (findingIdentities.has(identity)) {
      fail(field, `repeats pr ${entry.pr} key ${entry.key}`);
    }
    findingIdentities.add(identity);
  });

  requireArray(input.prSummaries, "prSummaries");
  const summaryPrs = new Set();
  input.prSummaries.forEach((summary, index) => {
    const field = `prSummaries[${index}]`;
    validatePrSummary(summary, field);
    if (summaryPrs.has(summary.pr)) {
      fail(`${field}.pr`, `repeats pr ${summary.pr}`);
    }
    summaryPrs.add(summary.pr);
  });

  requireArray(input.openIssues, "openIssues");
  const issueNumbers = new Set();
  input.openIssues.forEach((issue, index) => {
    const field = `openIssues[${index}]`;
    validateOpenIssue(issue, field);
    if (issueNumbers.has(issue.number)) {
      fail(`${field}.number`, `repeats issue ${issue.number}`);
    }
    issueNumbers.add(issue.number);
  });
}

/**
 * Renders the triage input file for `input` — the whole file object, `version` included —
 * as JSON with two-space indentation and a trailing newline. Throws if `input` violates
 * any constraint `parseInputFile` checks.
 */
export function renderInputFile(input) {
  validateInputFile(input);
  return `${JSON.stringify(input, null, 2)}\n`;
}

/**
 * Parses the text of a triage input file and returns the file object. Throws when the
 * text does not parse as JSON, or with an Error naming the first offending field when
 * any constraint fails.
 */
export function parseInputFile(text) {
  if (typeof text !== "string") {
    throw new Error("the triage input file text must be a string");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    throw new Error(`the triage input file does not parse as JSON: ${error.message}`, { cause: error });
  }
  validateInputFile(parsed);
  return parsed;
}
