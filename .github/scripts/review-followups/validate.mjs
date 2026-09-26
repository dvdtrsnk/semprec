#!/usr/bin/env node
/**
 * The triage proposal of the review follow-ups pipeline
 * (docs/adr/2026-09-26-merged-review-findings-become-proposed-follow-up-issues.md), and
 * its validator. This header is the reference description of the proposal format.
 *
 * The triage agent reads the triage input file (input-file.mjs), verifies each finding,
 * decomposes the valid ones into issue drafts and writes a proposal file. The `validate`
 * step checks that file with this module before anything reaches GitHub, and `publish`
 * checks it again before it writes. The agent writes the file, so it is a boundary:
 * `validateProposal` accepts any JSON value and reports every violation it finds.
 *
 * The proposal is JSON:
 *
 *   {
 *     "version": 1,
 *     "harvestIssue": <the input file's harvestIssue, H below>,
 *     "epic": null | { "title": string, "body": string },
 *     "issues": [{ "id": string, "title": string, "body": string, "findings": [{ "pr", "key" }] }],
 *     "rejected": [{ "pr", "key", "verdict", "reason", "trackedBy"? }],
 *     "advisories": [string]
 *   }
 *
 * No object may carry a field not listed above.
 *
 * - Every finding of the input file, identified by `(pr, key)`, appears exactly once
 *   across all `issues[].findings` and `rejected`; no other `(pr, key)` appears. `pr` is
 *   a positive integer and `key` ten lowercase hex characters.
 * - `rejected[].verdict` is one of `VERDICTS`, `reason` is non-empty after trimming, and
 *   `trackedBy` (a positive issue number) is present exactly when the verdict is
 *   `already-tracked`.
 * - `issues[].id` is kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`) and unique; `findings` is
 *   non-empty.
 * - With MM the number of drafts, draft number i (1-based, in array order) is titled
 *   `[followups-<H> NN/MM] <text>`, NN and MM zero-padded to two digits, `<text>`
 *   non-empty. The array is in topological order.
 * - The first line of a draft body is `**Blocked by:** none`, or `**Blocked by:** `
 *   followed by `, `-separated references: `#<N>` (a positive issue number other than
 *   `#<H>`, not checked against GitHub) or `{{draft:<id>}}` for a draft earlier in the
 *   array. `publish` replaces every
 *   `{{draft:<id>}}` with the real `#N` once that draft is created.
 * - A draft body contains the lines `## Context`, `## Task`, `## Touches`, `## Scope`,
 *   `### In scope`, `### Out of scope` and `## Acceptance criteria`, each exactly once,
 *   in that order. Every `{{draft:<id>}}` in it names another existing draft.
 * - A draft whose `## Touches` section mentions a path under `.relay/` or
 *   `.github/workflows/`, or `.github/scripts/check-protected-paths.mjs`, says
 *   `maintainer-implemented` in its `## Task` section: Relay refuses those paths.
 * - `epic` is non-null exactly when there are two or more drafts. Its title is
 *   `[followups-<H>] <text> — epic`, and its body links `#<H>` and contains no
 *   `{{draft:` (GitHub renders the drafts as its sub-issues).
 * - No body, draft or epic, contains `<!-- crb-followup` (`publish` appends the ledger
 *   markers itself) or exceeds 60,000 characters (GitHub's limit is 65,536, and the
 *   markers are appended after validation).
 * - `advisories` are free-text notes for the maintainer.
 *
 * Usage: node validate.mjs --input <input.json> --proposal <proposal.json>
 *
 * Prints one `ok` line with the counts and exits 0 for a valid proposal. Otherwise
 * prints each violation on its own line starting with `- ` and exits 1. An unreadable
 * file, invalid JSON, an invalid input file or a missing argument exits 1 with one line
 * saying which, on stderr.
 *
 * Zero dependencies; `validateProposal` performs no I/O.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { parseInputFile } from "./input-file.mjs";

export const VERDICTS = Object.freeze(["already-fixed", "invalid", "not-worth", "already-tracked"]);

const TOP_LEVEL_FIELDS = ["version", "harvestIssue", "epic", "issues", "rejected", "advisories"];
const EPIC_FIELDS = ["title", "body"];
const DRAFT_FIELDS = ["id", "title", "body", "findings"];
const FINDING_REF_FIELDS = ["pr", "key"];
const REJECTION_FIELDS = ["pr", "key", "verdict", "reason"];
const HEADINGS = [
  "## Context",
  "## Task",
  "## Touches",
  "## Scope",
  "### In scope",
  "### Out of scope",
  "## Acceptance criteria",
];

const MAX_BODY = 60000;
const MARKER = "<!-- crb-followup";
const BLOCKED_BY_PREFIX = "**Blocked by:** ";
const EPIC_SUFFIX = " — epic";
const PLACEHOLDER_OPEN = "{{draft:";
const PLACEHOLDER = /\{\{draft:([^}]*)\}\}/g;
const DRAFT_REFERENCE = /^\{\{draft:([^}]*)\}\}$/;
const ISSUE_REFERENCE = /^#([1-9][0-9]*)$/;
const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const HEX10 = /^[0-9a-f]{10}$/;
const PROTECTED_PATH = /(?<![\w./-])(?:\.relay\/|\.github\/workflows\/|\.github\/scripts\/check-protected-paths\.mjs(?![\w.-]))/;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function pad(number) {
  return String(number).padStart(2, "0");
}

function findingLabel(pr, key) {
  return `finding (pr ${pr}, key ${key})`;
}

/**
 * Reports a missing or unexpected field of `value` against `required` (plus `optional`),
 * or that it is not an object. Returns whether `value` is an object at all.
 */
function checkFields(value, label, violations, required, optional = []) {
  if (!isPlainObject(value)) {
    violations.push(`${label} must be an object`);
    return false;
  }
  for (const name of required) {
    if (!Object.hasOwn(value, name)) {
      violations.push(`${label} is missing field "${name}"`);
    }
  }
  for (const name of Object.keys(value)) {
    if (!required.includes(name) && !optional.includes(name)) {
      violations.push(`${label} has unexpected field "${name}"`);
    }
  }
  return true;
}

/** Whether `value` is a `(pr, key)` whose pr and key both have a valid shape. */
function hasValidIdentity(value) {
  return isPlainObject(value) && isPositiveInteger(value.pr) && typeof value.key === "string" && HEX10.test(value.key);
}

function checkIdentity(value, label, violations) {
  if (!isPositiveInteger(value.pr)) {
    violations.push(`${label} field "pr" must be a positive integer`);
  }
  if (typeof value.key !== "string" || !HEX10.test(value.key)) {
    violations.push(`${label} field "key" must be ten lowercase hex characters`);
  }
}

/** The lines of a body, without line terminators and trailing whitespace. */
function bodyLines(body) {
  return body.split(/\r?\n/).map((line) => line.trimEnd());
}

/** The lines between the line `heading` and the next `## ` heading, or "" when absent. */
function sectionText(lines, heading) {
  const start = lines.indexOf(heading);
  if (start === -1) {
    return "";
  }
  const section = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) {
      break;
    }
    section.push(line);
  }
  return section.join("\n");
}

/** Checks rules shared by draft and epic bodies: the marker and the length cap. */
function checkCommonBody(body, label, violations) {
  if (body.includes(MARKER)) {
    violations.push(`${label} body contains the pipeline marker "${MARKER}"`);
  }
  if (body.length > MAX_BODY) {
    violations.push(`${label} body is ${body.length} characters, over the ${MAX_BODY} limit`);
  }
}

function checkBlockedBy(firstLine, label, index, draftIndexById, harvestIssue, violations) {
  if (firstLine === `${BLOCKED_BY_PREFIX}none`) {
    return;
  }
  if (!firstLine.startsWith(BLOCKED_BY_PREFIX) || firstLine.length === BLOCKED_BY_PREFIX.length) {
    violations.push(`${label} body must start with "${BLOCKED_BY_PREFIX}none" or "${BLOCKED_BY_PREFIX}" and references`);
    return;
  }
  for (const reference of firstLine.slice(BLOCKED_BY_PREFIX.length).split(", ")) {
    const issue = ISSUE_REFERENCE.exec(reference);
    if (issue) {
      if (Number(issue[1]) === harvestIssue) {
        violations.push(`${label} Blocked-by line references the harvest issue #${harvestIssue}`);
      }
      continue;
    }
    const draft = DRAFT_REFERENCE.exec(reference);
    if (!draft) {
      violations.push(`${label} Blocked-by line has invalid reference "${reference}"`);
      continue;
    }
    const target = draftIndexById.get(draft[1]);
    if (target === undefined) {
      violations.push(`${label} Blocked-by line references unknown draft "${draft[1]}"`);
    } else if (target >= index) {
      violations.push(`${label} Blocked-by line references draft "${draft[1]}", which does not come earlier`);
    }
  }
}

function checkHeadings(lines, label, violations) {
  const positions = [];
  for (const heading of HEADINGS) {
    const count = lines.filter((line) => line === heading).length;
    if (count === 0) {
      violations.push(`${label} body is missing the heading "${heading}"`);
    } else if (count > 1) {
      violations.push(`${label} body has the heading "${heading}" ${count} times`);
    } else {
      positions.push(lines.indexOf(heading));
    }
  }
  if (positions.length === HEADINGS.length && positions.some((position, i) => i > 0 && position < positions[i - 1])) {
    violations.push(`${label} body headings are not in the order ${HEADINGS.join(", ")}`);
  }
}

/** Checks the placeholders after the Blocked-by line, which `checkBlockedBy` covers. */
function checkPlaceholders(text, label, id, draftIndexById, violations) {
  const matches = [...text.matchAll(PLACEHOLDER)];
  for (const [, target] of matches) {
    if (target === id) {
      violations.push(`${label} body references itself as "{{draft:${target}}}"`);
    } else if (!draftIndexById.has(target)) {
      violations.push(`${label} body references unknown draft "{{draft:${target}}}"`);
    }
  }
  if (text.split(PLACEHOLDER_OPEN).length - 1 > matches.length) {
    violations.push(`${label} body has a malformed "${PLACEHOLDER_OPEN}" placeholder`);
  }
}

function checkDraftBody(body, label, id, index, draftIndexById, harvestIssue, violations) {
  checkCommonBody(body, label, violations);
  const lines = bodyLines(body);
  checkBlockedBy(lines[0], label, index, draftIndexById, harvestIssue, violations);
  checkHeadings(lines, label, violations);
  checkPlaceholders(lines.slice(1).join("\n"), label, id, draftIndexById, violations);
  if (
    PROTECTED_PATH.test(sectionText(lines, "## Touches")) &&
    !sectionText(lines, "## Task").includes("maintainer-implemented")
  ) {
    violations.push(`${label} touches a protected path but its Task does not say "maintainer-implemented"`);
  }
}

/** Validates `issues`; returns the `(pr, key)` claims of its drafts for the completeness check. */
function checkIssues(issues, harvestIssue, violations) {
  const claims = [];
  const draftIndexById = new Map();
  issues.forEach((draft, index) => {
    if (isPlainObject(draft) && typeof draft.id === "string" && !draftIndexById.has(draft.id)) {
      draftIndexById.set(draft.id, index);
    }
  });

  const seenIds = new Set();
  const total = pad(issues.length);
  issues.forEach((draft, index) => {
    const id = isPlainObject(draft) && typeof draft.id === "string" ? draft.id : null;
    const label = id === null ? `issues[${index}]` : `draft "${id}"`;
    if (!checkFields(draft, label, violations, DRAFT_FIELDS)) {
      return;
    }

    if (id === null || !ID.test(id)) {
      violations.push(`${label} field "id" must be kebab-case`);
    }
    if (id !== null) {
      if (seenIds.has(id)) {
        violations.push(`${label} repeats an id used by an earlier draft`);
      }
      seenIds.add(id);
    }

    const prefix = `[followups-${harvestIssue} ${pad(index + 1)}/${total}] `;
    if (typeof draft.title !== "string" || !draft.title.startsWith(prefix) || draft.title.slice(prefix.length).trim() === "") {
      violations.push(`${label} title must be "${prefix}<text>" with non-empty text`);
    }

    if (!Array.isArray(draft.findings) || draft.findings.length === 0) {
      violations.push(`${label} field "findings" must be a non-empty array`);
    } else {
      draft.findings.forEach((finding, findingIndex) => {
        const findingField = `${label} findings[${findingIndex}]`;
        if (checkFields(finding, findingField, violations, FINDING_REF_FIELDS)) {
          checkIdentity(finding, findingField, violations);
        }
        if (hasValidIdentity(finding)) {
          claims.push({ pr: finding.pr, key: finding.key, where: label });
        }
      });
    }

    if (typeof draft.body !== "string") {
      violations.push(`${label} field "body" must be a string`);
    } else {
      checkDraftBody(draft.body, label, id, index, draftIndexById, harvestIssue, violations);
    }
  });
  return claims;
}

/** Validates `rejected`; returns its `(pr, key)` claims for the completeness check. */
function checkRejected(rejected, violations) {
  const claims = [];
  rejected.forEach((rejection, index) => {
    const label = hasValidIdentity(rejection)
      ? `rejected[${index}] (pr ${rejection.pr}, key ${rejection.key})`
      : `rejected[${index}]`;
    if (!checkFields(rejection, label, violations, REJECTION_FIELDS, ["trackedBy"])) {
      return;
    }
    checkIdentity(rejection, label, violations);
    if (!VERDICTS.includes(rejection.verdict)) {
      violations.push(`${label} field "verdict" must be one of ${VERDICTS.join(", ")}`);
    }
    if (typeof rejection.reason !== "string" || rejection.reason.trim() === "") {
      violations.push(`${label} field "reason" must be a non-empty string`);
    }
    if (rejection.verdict === "already-tracked") {
      if (!isPositiveInteger(rejection.trackedBy)) {
        violations.push(`${label} is already-tracked, so field "trackedBy" must be a positive integer`);
      }
    } else if (Object.hasOwn(rejection, "trackedBy")) {
      violations.push(`${label} field "trackedBy" is only allowed with the already-tracked verdict`);
    }
    if (hasValidIdentity(rejection)) {
      claims.push({ pr: rejection.pr, key: rejection.key, where: "rejected" });
    }
  });
  return claims;
}

function checkCompleteness(inputFindings, claims, violations) {
  const claimsByIdentity = new Map();
  for (const claim of claims) {
    const identity = `${claim.pr}:${claim.key}`;
    if (!claimsByIdentity.has(identity)) {
      claimsByIdentity.set(identity, []);
    }
    claimsByIdentity.get(identity).push(claim);
  }
  const inputIdentities = new Set();
  for (const { pr, key } of inputFindings) {
    const identity = `${pr}:${key}`;
    inputIdentities.add(identity);
    const found = claimsByIdentity.get(identity) ?? [];
    if (found.length === 0) {
      violations.push(`${findingLabel(pr, key)} is in no draft and not rejected`);
    } else if (found.length > 1) {
      violations.push(`${findingLabel(pr, key)} appears ${found.length} times: ${found.map((c) => c.where).join(", ")}`);
    }
  }
  for (const [identity, found] of claimsByIdentity) {
    if (!inputIdentities.has(identity)) {
      violations.push(`${findingLabel(found[0].pr, found[0].key)} is not in the input file`);
    }
  }
}

function checkEpic(epic, draftCount, harvestIssue, violations) {
  if (epic === null) {
    if (draftCount >= 2) {
      violations.push(`epic must be present with ${draftCount} drafts`);
    }
    return;
  }
  if (draftCount < 2) {
    violations.push(`epic must be null with ${draftCount} draft${draftCount === 1 ? "" : "s"}`);
  }
  if (!checkFields(epic, "epic", violations, EPIC_FIELDS)) {
    return;
  }
  const prefix = `[followups-${harvestIssue}] `;
  if (
    !isNonEmptyString(epic.title) ||
    !epic.title.startsWith(prefix) ||
    !epic.title.endsWith(EPIC_SUFFIX) ||
    epic.title.slice(prefix.length, epic.title.length - EPIC_SUFFIX.length).trim() === ""
  ) {
    violations.push(`epic title must be "${prefix}<text>${EPIC_SUFFIX}" with non-empty text`);
  }
  if (!isNonEmptyString(epic.body)) {
    violations.push(`epic field "body" must be a non-empty string`);
    return;
  }
  checkCommonBody(epic.body, "epic", violations);
  if (!new RegExp(`#${harvestIssue}(?![0-9])`).test(epic.body)) {
    violations.push(`epic body must link the harvest issue #${harvestIssue}`);
  }
  if (epic.body.includes(PLACEHOLDER_OPEN)) {
    violations.push(`epic body must not contain "${PLACEHOLDER_OPEN}"`);
  }
}

/**
 * Validates `proposal`, any parsed JSON value, against the parsed triage input file
 * `input`. Returns every violation found, each naming the draft, rejection or
 * `(pr, key)` it concerns; an empty array means the proposal is valid. Never throws on a
 * malformed proposal.
 */
export function validateProposal(input, proposal) {
  const violations = [];
  if (!checkFields(proposal, "proposal", violations, TOP_LEVEL_FIELDS)) {
    return violations;
  }
  const harvestIssue = input.harvestIssue;

  if (proposal.version !== 1) {
    violations.push(`proposal field "version" must be 1`);
  }
  if (proposal.harvestIssue !== harvestIssue) {
    violations.push(`proposal field "harvestIssue" must be ${harvestIssue}`);
  }
  if (!Array.isArray(proposal.advisories) || !proposal.advisories.every((advisory) => typeof advisory === "string")) {
    violations.push(`proposal field "advisories" must be an array of strings`);
  }

  const issuesValid = Array.isArray(proposal.issues);
  const rejectedValid = Array.isArray(proposal.rejected);
  const claims = [];
  if (issuesValid) {
    claims.push(...checkIssues(proposal.issues, harvestIssue, violations));
  } else {
    violations.push(`proposal field "issues" must be an array`);
  }
  if (rejectedValid) {
    claims.push(...checkRejected(proposal.rejected, violations));
  } else {
    violations.push(`proposal field "rejected" must be an array`);
  }
  // Without both lists every input finding would also be reported missing, burying the real cause.
  if (issuesValid && rejectedValid) {
    checkCompleteness(input.findings, claims, violations);
  }

  if (Object.hasOwn(proposal, "epic") && issuesValid) {
    checkEpic(proposal.epic, proposal.issues.length, harvestIssue, violations);
  }
  return violations;
}

/** A failure the CLI reports as one line and exit code 1. */
class UsageError extends Error {}

function parseArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    if (name !== "--input" && name !== "--proposal") {
      throw new UsageError(`unknown argument "${name}"`);
    }
    if (i + 1 >= argv.length) {
      throw new UsageError(`missing value for ${name}`);
    }
    options[name.slice(2)] = argv[i + 1];
  }
  for (const name of ["input", "proposal"]) {
    if (options[name] === undefined) {
      throw new UsageError(`missing argument --${name}`);
    }
  }
  return options;
}

function readText(path, option) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (typeof error?.code !== "string") {
      throw error;
    }
    throw new UsageError(`cannot read --${option} file ${path}: ${error.message}`, { cause: error });
  }
}

function load(options) {
  const inputText = readText(options.input, "input");
  const proposalText = readText(options.proposal, "proposal");
  let input;
  try {
    input = parseInputFile(inputText);
  } catch (error) {
    // parseInputFile reports a malformed file with a plain Error; anything else is a bug.
    if (!(error instanceof Error) || error.constructor !== Error) {
      throw error;
    }
    throw new UsageError(`invalid --input file ${options.input}: ${error.message}`, { cause: error });
  }
  let proposal;
  try {
    proposal = JSON.parse(proposalText);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    throw new UsageError(`--proposal file ${options.proposal} does not parse as JSON: ${error.message}`, { cause: error });
  }
  return { input, proposal };
}

/**
 * Runs the CLI on `argv` (the arguments after the script path) and returns the exit
 * code: 0 for a valid proposal, 1 for violations or a usage, read or parse failure.
 */
export function main(argv) {
  let loaded;
  try {
    loaded = load(parseArguments(argv));
  } catch (error) {
    if (!(error instanceof UsageError)) {
      throw error;
    }
    console.error(error.message);
    return 1;
  }
  const { input, proposal } = loaded;
  const violations = validateProposal(input, proposal);
  if (violations.length > 0) {
    for (const violation of violations) {
      console.log(`- ${violation}`);
    }
    return 1;
  }
  console.log(
    `ok ${proposal.issues.length} drafts, ${proposal.rejected.length} rejected, ` +
      `${input.findings.length} findings, ${proposal.advisories.length} advisories`,
  );
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
