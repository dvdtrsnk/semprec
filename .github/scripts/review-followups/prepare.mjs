/**
 * The triage workflow's `prepare` step of the review follow-ups pipeline
 * (docs/adr/2026-09-26-merged-review-findings-become-proposed-follow-up-issues.md).
 *
 *   node prepare.mjs --harvest-issue <n> --out <dir>
 *
 * Turns harvest issue `<n>` into `<dir>/input.json`, the triage input file of
 * input-file.mjs, so the triage agent has everything it needs without touching GitHub.
 * `<dir>` is created when missing.
 *
 * Inputs, all read from GitHub through github.mjs (`clientFromEnv`: GITHUB_API_URL,
 * GITHUB_GRAPHQL_URL, GITHUB_TOKEN, GITHUB_REPOSITORY):
 *   - the harvest issue, which must be open and labelled `followups:harvest`, and its
 *     data block (records.mjs, `parseHarvestBlock`);
 *   - every `followups:issue` issue and the harvest issue's comments, for the terminal
 *     ledger (markers.mjs, `computeLedger`);
 *   - the review threads of each pull request with a kept finding, for the full text of
 *     a finding whose `discussionId` names a thread's root comment. A root by a trusted
 *     review bot in the bot's format (`**<category> | <SEVERITY>**`, the description,
 *     then optionally `**Suggested fix:**` and a fenced fix) is split into `fullText`
 *     and `suggestedFix`; any other root is `fullText` as a whole. Later comments are
 *     `threadReplies`. A finding without a thread gets `null`, `null` and `[]`;
 *   - the comments of those pull requests, for each one's newest trusted
 *     `## AI Code Review Summary` comment;
 *   - the open issues labelled `agent:ready`, `spec:approved` or `spec:proposed`, with
 *     their `## Touches` sections.
 *
 * Re-runs: a finding in the terminal ledger was already published by an earlier attempt
 * (as a `followups:issue` issue, or as a rejection in a triage-result comment) and is
 * dropped, so a finding is never proposed twice. The step itself only reads GitHub, so
 * it is safe to re-run at any point.
 *
 * Output: prints how many findings are pending and how many were already published, and
 * exits 0, also when nothing is pending. A missing or invalid argument, or any error,
 * exits non-zero without writing a file.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { clientFromEnv, getIssue, listIssueComments, listIssuesWithLabel, listReviewThreads } from "./github.mjs";
import { renderInputFile } from "./input-file.mjs";
import { computeLedger, findingId, LABELS } from "./markers.mjs";
import { TRUSTED_REVIEW_BOT_LOGINS } from "./memory.mjs";
import { parseHarvestBlock } from "./records.mjs";

const QUEUED_LABELS = ["agent:ready", "spec:approved", LABELS.proposed];
const SUMMARY_PREFIX = "## AI Code Review Summary";
const FINDING_HEADER_RE = /^\*\*.*\|.*\*\*$/;
const SUGGESTED_FIX_LINE = "**Suggested fix:**";
const FENCED_RE = /^```[^\n]*\n([\s\S]*?)\n?```$/;
const TOUCHES_HEADING = "## Touches";

/**
 * Splits a thread root into `{ fullText, suggestedFix }`: the bot's format when a trusted
 * bot wrote it and its first line is the `**… | …**` header, the whole body otherwise.
 */
function splitRoot(root) {
  const lines = root.body.replace(/\r\n/g, "\n").split("\n");
  if (!TRUSTED_REVIEW_BOT_LOGINS.includes(root.author) || !FINDING_HEADER_RE.test(lines[0].trimEnd())) {
    return { fullText: root.body, suggestedFix: null };
  }
  const rest = lines.slice(1);
  const fixIndex = rest.findIndex((line) => line.trimEnd() === SUGGESTED_FIX_LINE);
  if (fixIndex === -1) {
    return { fullText: rest.join("\n").trim(), suggestedFix: null };
  }
  const fence = FENCED_RE.exec(rest.slice(fixIndex + 1).join("\n").trim());
  return { fullText: rest.slice(0, fixIndex).join("\n").trim(), suggestedFix: fence ? fence[1] : null };
}

/** The text of the `## Touches` section of `body`, or "" when it has none. */
function touchesSection(body) {
  const lines = body.split(/\r?\n/);
  const start = lines.indexOf(TOUCHES_HEADING);
  if (start === -1) return "";
  const section = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    section.push(line);
  }
  return section.join("\n").trim();
}

/** The newest comment by a trusted bot starting with the summary heading, or null. */
function newestSummary(comments) {
  let newest = null;
  for (const comment of comments) {
    if (!TRUSTED_REVIEW_BOT_LOGINS.includes(comment.author) || !comment.body.startsWith(SUMMARY_PREFIX)) continue;
    if (newest === null || comment.createdAt >= newest.createdAt) newest = comment;
  }
  return newest;
}

async function listOpenQueuedIssues(api) {
  const byNumber = new Map();
  for (const label of QUEUED_LABELS) {
    for (const issue of await api.listIssuesWithLabel(label, "open")) {
      if (!byNumber.has(issue.number)) {
        byNumber.set(issue.number, {
          number: issue.number,
          title: issue.title,
          labels: issue.labels,
          touches: touchesSection(issue.body),
        });
      }
    }
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

/** The triage input object plus how many of the block's findings were already published. */
async function buildInput(api, harvestIssue) {
  const issue = await api.getIssue(harvestIssue);
  if (issue.state !== "open") throw new Error(`harvest issue #${harvestIssue} is ${issue.state}, not open`);
  if (!issue.labels.includes(LABELS.harvest)) {
    throw new Error(`issue #${harvestIssue} is not labelled ${LABELS.harvest}`);
  }
  const data = parseHarvestBlock(issue.body);

  const followups = await api.listIssuesWithLabel(LABELS.issue, "all");
  const harvestComments = await api.listIssueComments(harvestIssue);
  const { terminal } = computeLedger([
    ...followups.map(({ number, labels, body }) => ({ number, labels, body, comments: [] })),
    {
      number: issue.number,
      labels: issue.labels,
      body: issue.body,
      comments: harvestComments.map(({ author, body }) => ({ author, body })),
    },
  ]);
  const kept = data.findings.filter((finding) => !terminal.has(findingId(finding)));

  const threadsByPr = new Map();
  const findings = [];
  for (const finding of kept) {
    let thread;
    if (finding.discussionId !== "") {
      if (!threadsByPr.has(finding.pr)) threadsByPr.set(finding.pr, await api.listReviewThreads(finding.pr));
      thread = threadsByPr
        .get(finding.pr)
        .find((candidate) => String(candidate.comments[0]?.databaseId) === finding.discussionId);
    }
    if (thread === undefined) {
      findings.push({ ...finding, fullText: null, suggestedFix: null, threadReplies: [] });
      continue;
    }
    const [root, ...replies] = thread.comments;
    findings.push({
      ...finding,
      ...splitRoot(root),
      threadReplies: replies.map(({ author, body }) => ({ author, body })),
    });
  }

  const prSummaries = [];
  for (const pr of new Set(kept.map((finding) => finding.pr))) {
    const summary = newestSummary(await api.listIssueComments(pr));
    if (summary !== null) prSummaries.push({ pr, body: summary.body });
  }

  const input = {
    version: 1,
    harvestIssue,
    findings,
    prSummaries,
    openIssues: await listOpenQueuedIssues(api),
  };
  return { input, published: data.findings.length - kept.length };
}

/**
 * Builds the triage input object for `harvestIssue`. `api` holds `getIssue(number)`,
 * `listIssuesWithLabel(label, state)`, `listIssueComments(number)` and
 * `listReviewThreads(prNumber)`, the github.mjs endpoints of the same names bound to a
 * client. Throws unless the issue is open, labelled `followups:harvest` and carries a
 * valid data block; any error from `api` rejects the call.
 */
export async function prepareInput(api, harvestIssue) {
  return (await buildInput(api, harvestIssue)).input;
}

function apiFromClient(client) {
  return {
    getIssue: (number) => getIssue(client, number),
    listIssuesWithLabel: (label, state) => listIssuesWithLabel(client, label, state),
    listIssueComments: (number) => listIssueComments(client, number),
    listReviewThreads: (prNumber) => listReviewThreads(client, prNumber),
  };
}

function parseArgs(argv) {
  const usage = "usage: node prepare.mjs --harvest-issue <n> --out <dir>";
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const [name, value] = [argv[i], argv[i + 1]];
    if (name !== "--harvest-issue" && name !== "--out") throw new Error(`unknown argument "${name}"; ${usage}`);
    if (values.has(name)) throw new Error(`${name} is given twice; ${usage}`);
    if (value === undefined || value === "") throw new Error(`${name} needs a value; ${usage}`);
    values.set(name, value);
  }
  const issueText = values.get("--harvest-issue");
  const out = values.get("--out");
  if (issueText === undefined || out === undefined) throw new Error(usage);
  const harvestIssue = Number(issueText);
  if (!/^[1-9][0-9]*$/.test(issueText) || !Number.isSafeInteger(harvestIssue)) {
    throw new Error(`--harvest-issue must be a positive integer, got "${issueText}"`);
  }
  return { harvestIssue, out };
}

/**
 * Runs the step for `argv` (without the node and script paths). `api` defaults to one
 * built from `clientFromEnv`. Rejects, without writing a file, on an invalid argument
 * or any error.
 */
export async function main(argv, api) {
  const { harvestIssue, out } = parseArgs(argv);
  const { input, published } = await buildInput(api ?? apiFromClient(clientFromEnv()), harvestIssue);
  const text = renderInputFile(input);
  await mkdir(out, { recursive: true });
  const file = path.join(out, "input.json");
  await writeFile(file, text);
  console.log(
    `harvest issue #${harvestIssue}: ${input.findings.length} finding(s) pending, ${published} already published; wrote ${file}`,
  );
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
