/**
 * The review follow-ups pipeline's state grammar: its labels, the HTML markers it
 * writes into issue bodies and comments, and the one function that reads them back
 * into a ledger.
 *
 * The pipeline keeps all of its state in GitHub (decision:
 * docs/adr/2026-09-26-merged-review-findings-become-proposed-follow-up-issues.md).
 * The harvest, the triage `prepare` step and the triage `publish` step all read that
 * state through `computeLedger`, and every writer renders its markers through the
 * functions below, so readers and writers cannot drift apart.
 *
 * The repository is public, so not every marker counts:
 *
 *   - A marker is recognised only when a line of the text, after trimming trailing
 *     whitespace and `\r`, is exactly the marker. A marker quoted inside a table cell,
 *     a JSON string or a sentence is not one, and neither is a line that starts like a
 *     marker but does not match its grammar exactly.
 *   - An issue body counts only on an issue carrying a pipeline label, which only a
 *     collaborator can set.
 *   - A comment counts only when PUBLISHER_LOGIN wrote it and it carries a result
 *     marker, and only on a `followups:harvest` issue.
 *
 * Grammar: `<n>` is a positive integer without leading zeros; `<key>` is exactly ten
 * lowercase hex characters.
 *
 *   <!-- crb-followup:v1 pr=<n> key=<key> -->            one finding
 *   <!-- crb-followup-harvest:v1 prs=<n>,<n>,... -->     pull requests a harvest covers
 *                                                        (ascending, no duplicates)
 *   <!-- crb-followup-epic:v1 harvest=<n> -->            the epic of a harvest issue
 *   <!-- crb-followup-result:v1 harvest=<n> -->          a triage result comment
 */

export const LABELS = Object.freeze({
  harvested: "followups:harvested",
  harvest: "followups:harvest",
  ready: "followups:ready",
  issue: "followups:issue",
  proposed: "spec:proposed",
});

export const PUBLISHER_LOGIN = "bb-agent-relay[bot]";

const NUMBER = "[1-9]\\d*";
const FINDING_RE = new RegExp(`^<!-- crb-followup:v1 pr=(${NUMBER}) key=([0-9a-f]{10}) -->$`);
const HARVEST_RE = new RegExp(`^<!-- crb-followup-harvest:v1 prs=(${NUMBER}(?:,${NUMBER})*) -->$`);
const EPIC_RE = new RegExp(`^<!-- crb-followup-epic:v1 harvest=(${NUMBER}) -->$`);
const RESULT_RE = new RegExp(`^<!-- crb-followup-result:v1 harvest=(${NUMBER}) -->$`);
const KEY_RE = /^[0-9a-f]{10}$/;

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function requirePositiveInteger(value, name) {
  if (!isPositiveInteger(value)) {
    throw new TypeError(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  }
}

/** The capture groups of every line of `text` that matches `re` exactly, in order. */
function matchLines(text, re) {
  if (typeof text !== "string") throw new TypeError("marker text must be a string");
  const matches = [];
  for (const line of text.split("\n")) {
    const match = re.exec(line.replace(/\s+$/, ""));
    if (match) matches.push(match);
  }
  return matches;
}

/** A matched decimal, or null when it exceeds the safe integer range. */
function toNumber(digits) {
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}

/** Parses a `prs=` list, or null when it is not ascending, has duplicates or overflows. */
function toPrList(csv) {
  const prs = csv.split(",").map(toNumber);
  for (let i = 0; i < prs.length; i++) {
    if (prs[i] === null || (i > 0 && prs[i] <= prs[i - 1])) return null;
  }
  return prs;
}

function parseSingleNumber(text, re) {
  for (const match of matchLines(text, re)) {
    const value = toNumber(match[1]);
    if (value !== null) return value;
  }
  return null;
}

export function renderFindingMarker({ pr, key }) {
  requirePositiveInteger(pr, "pr");
  if (typeof key !== "string" || !KEY_RE.test(key)) {
    throw new TypeError(`key must be ten lowercase hex characters, got ${JSON.stringify(key)}`);
  }
  return `<!-- crb-followup:v1 pr=${pr} key=${key} -->`;
}

/** Every finding marker in `text`, as `{ pr, key }`, in order of appearance. */
export function parseFindingMarkers(text) {
  const findings = [];
  for (const match of matchLines(text, FINDING_RE)) {
    const pr = toNumber(match[1]);
    if (pr !== null) findings.push({ pr, key: match[2] });
  }
  return findings;
}

export function renderHarvestMarker(prs) {
  if (!Array.isArray(prs) || prs.length === 0) {
    throw new TypeError("prs must be a non-empty array");
  }
  prs.forEach((pr, i) => {
    requirePositiveInteger(pr, "pr");
    if (i > 0 && pr <= prs[i - 1]) {
      throw new TypeError("prs must be ascending without duplicates");
    }
  });
  return `<!-- crb-followup-harvest:v1 prs=${prs.join(",")} -->`;
}

/** The pull requests of the first harvest marker in `text`, or null when there is none. */
export function parseHarvestMarker(text) {
  return parseAllHarvestMarkers(text)[0] ?? null;
}

function parseAllHarvestMarkers(text) {
  return matchLines(text, HARVEST_RE)
    .map((match) => toPrList(match[1]))
    .filter((prs) => prs !== null);
}

export function renderEpicMarker(harvest) {
  requirePositiveInteger(harvest, "harvest");
  return `<!-- crb-followup-epic:v1 harvest=${harvest} -->`;
}

/** The harvest number of the first epic marker in `text`, or null when there is none. */
export function parseEpicMarker(text) {
  return parseSingleNumber(text, EPIC_RE);
}

export function renderResultMarker(harvest) {
  requirePositiveInteger(harvest, "harvest");
  return `<!-- crb-followup-result:v1 harvest=${harvest} -->`;
}

/** The harvest number of the first result marker in `text`, or null when there is none. */
export function parseResultMarker(text) {
  return parseSingleNumber(text, RESULT_RE);
}

export function findingId({ pr, key }) {
  return `${pr}:${key}`;
}

function validateIssue(issue, index) {
  const where = `issues[${index}]`;
  if (issue === null || typeof issue !== "object") throw new TypeError(`${where} must be an object`);
  requirePositiveInteger(issue.number, `${where}.number`);
  if (!Array.isArray(issue.labels) || !issue.labels.every((label) => typeof label === "string")) {
    throw new TypeError(`${where}.labels must be an array of strings`);
  }
  if (typeof issue.body !== "string") throw new TypeError(`${where}.body must be a string`);
  if (!Array.isArray(issue.comments)) throw new TypeError(`${where}.comments must be an array`);
  issue.comments.forEach((comment, j) => {
    if (
      comment === null ||
      typeof comment !== "object" ||
      typeof comment.author !== "string" ||
      typeof comment.body !== "string"
    ) {
      throw new TypeError(`${where}.comments[${j}] must have string author and body`);
    }
  });
}

/**
 * Reads the pipeline's state out of `issues`
 * (`{ number, labels: string[], body: string, comments: { author, body }[] }[]`).
 * Throws a TypeError when an issue does not have that shape. Pure; an issue's open or
 * closed state does not matter.
 *
 *   - `harvested`: finding ids from `followups:harvest` and `followups:issue` bodies,
 *     and from PUBLISHER_LOGIN comments carrying a result marker on
 *     `followups:harvest` issues.
 *   - `terminal`: the same, without the `followups:harvest` bodies — including the
 *     body of an issue that carries `followups:issue` as well.
 *   - `harvestedPrs`: pull requests of harvest markers in `followups:harvest` bodies.
 *   - `epics`: harvest issue number → epic issue number, from epic markers in
 *     `followups:issue` bodies; the lower epic number wins.
 *
 * An issue with neither pipeline label contributes nothing.
 */
export function computeLedger(issues) {
  if (!Array.isArray(issues)) throw new TypeError("issues must be an array");
  issues.forEach(validateIssue);

  const harvested = new Set();
  const terminal = new Set();
  const harvestedPrs = new Set();
  const epics = new Map();

  for (const issue of issues) {
    const isHarvest = issue.labels.includes(LABELS.harvest);
    const isFollowup = issue.labels.includes(LABELS.issue);
    if (!isHarvest && !isFollowup) continue;

    for (const finding of parseFindingMarkers(issue.body)) {
      harvested.add(findingId(finding));
      if (!isHarvest) terminal.add(findingId(finding));
    }

    if (isHarvest) {
      for (const prs of parseAllHarvestMarkers(issue.body)) {
        for (const pr of prs) harvestedPrs.add(pr);
      }
      for (const comment of issue.comments) {
        if (comment.author !== PUBLISHER_LOGIN || parseResultMarker(comment.body) === null) continue;
        for (const finding of parseFindingMarkers(comment.body)) {
          harvested.add(findingId(finding));
          terminal.add(findingId(finding));
        }
      }
    }

    if (isFollowup) {
      const harvest = parseEpicMarker(issue.body);
      if (harvest !== null && (!epics.has(harvest) || issue.number < epics.get(harvest))) {
        epics.set(harvest, issue.number);
      }
    }
  }

  return { harvested, terminal, harvestedPrs, epics };
}
