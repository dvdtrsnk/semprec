#!/usr/bin/env node
/**
 * The review follow-ups harvest (decision:
 * docs/adr/2026-09-26-merged-review-findings-become-proposed-follow-up-issues.md): the
 * script the daily `harvest-review-followups` workflow (added by #583) runs. It collects
 * the code-review bot's open findings from merged pull requests into one harvest issue
 * labelled `followups:ready`, which Relay's `triage-review-followups` workflow then
 * picks up.
 *
 * It is deterministic and uses no AI. Every decision lives in the modules it calls
 * (markers, records, memory, select, hints); this script fetches, calls them, renders
 * and writes. A run, in order:
 *
 *   1. Backpressure — when an open issue carries `followups:harvest`, or both
 *      `followups:issue` and `spec:proposed`, it reports those issues and does nothing
 *      else.
 *   2. Ledger — reads every `followups:harvest` issue (with its comments) and every
 *      `followups:issue` issue, in any state, and the file tree of `develop`.
 *   3. Scan — offers the merged pull requests from HARVEST_MIN_PR up that lack
 *      `followups:harvested` to the harvest plan, in ascending order, until the cap
 *      stops it. A pull request already listed in a harvest issue's harvest marker is
 *      only labelled. A trusted review memory that cannot be decoded fails the run,
 *      naming the pull request, before any write.
 *   4. Hints — attaches `touchedAfterLastSeen` and `laterPrsTouchingPath` to every
 *      harvested finding.
 *   5. Render — the harvest issue's title and body. A body over MAX_BODY_LENGTH
 *      characters fails the run before any write.
 *   6. Write — creates the harvest issue first (`followups:harvest` and
 *      `followups:ready`; or, when every finding was skipped as fixed, `followups:harvest`
 *      only and closed at once; or no issue when there is no finding at all), and only
 *      then labels every planned pull request `followups:harvested`. A crash between the
 *      two leaves the harvest issue open, so it holds back every harvest until triage
 *      closes it; the next run then finds the pull requests in its harvest marker and
 *      only labels them. A crash between creating a record-only
 *      issue and closing it leaves an open `followups:harvest` issue that no triage
 *      picks up; it holds back every later harvest until someone closes it.
 *
 * Environment variables:
 *   HARVEST_MIN_PR    — the lowest pull request number to harvest (required, a positive
 *                       integer)
 *   DRY_RUN           — `true` reports what the run would write and writes nothing;
 *                       `false` writes (required, exactly one of the two)
 *   GITHUB_STEP_SUMMARY — when set, the report is appended to this file as Markdown
 *   GITHUB_API_URL, GITHUB_GRAPHQL_URL, GITHUB_TOKEN, GITHUB_REPOSITORY — read by
 *                       `clientFromEnv` (github.mjs)
 *
 * Run directly, it prints the report and exits 1 on any error.
 */

import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  addLabels,
  clientFromEnv,
  closeIssue,
  createIssue,
  listIssueComments,
  listIssuesWithLabel,
  listMergedPullRequests,
  listReviewThreads,
  listTreePaths,
} from "./github.mjs";
import { computeHints, hintsApi } from "./hints.mjs";
import { LABELS, computeLedger, findingId, renderFindingMarker, renderHarvestMarker } from "./markers.mjs";
import { decodeMemory, parseMemory, selectMemoryComment } from "./memory.mjs";
import { renderHarvestBlock, validateFindingRecord } from "./records.mjs";
import { candidatePullRequests, classifyPullRequest, createHarvestPlan, pendingWork } from "./select.mjs";

const BASE = "develop";
const MAX_BODY_LENGTH = 60_000;
const DIGITS = /^[0-9]+$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/** `issues` without a second entry for the same number; the first one wins. */
function uniqueByNumber(issues) {
  const byNumber = new Map();
  for (const issue of issues) if (!byNumber.has(issue.number)) byNumber.set(issue.number, issue);
  return [...byNumber.values()];
}

async function readLedgerIssues(api) {
  const harvests = await api.listIssuesWithLabel(LABELS.harvest, "all");
  const followups = await api.listIssuesWithLabel(LABELS.issue, "all");
  const withComments = [];
  for (const issue of harvests) {
    withComments.push({ ...issue, comments: await api.listIssueComments(issue.number) });
  }
  // Only comments on a harvest issue count in the ledger, so a follow-up issue's are not read.
  return uniqueByNumber([...withComments, ...followups.map((issue) => ({ ...issue, comments: [] }))]);
}

/** The pull request's parsed memory findings, or null without a memory; any failure names the pull request. */
async function readMemoryFindings(api, pr) {
  try {
    const memory = selectMemoryComment(await api.listIssueComments(pr));
    return memory === null ? null : parseMemory(decodeMemory(memory.body), pr).findings;
  } catch (error) {
    throw new Error(`cannot read the review memory of pull request #${pr}: ${error.message}`, { cause: error });
  }
}

/** Whether classifying needs the review threads: an open, unharvested finding with a numeric thread id. */
function needsThreads(pr, memoryFindings, ledger) {
  return (memoryFindings ?? []).some(
    (finding) =>
      finding.status === "open" &&
      !ledger.harvested.has(findingId({ pr, key: finding.key })) &&
      DIGITS.test(finding.discussionId),
  );
}

async function addHints(api, harvest, mergedAt) {
  const byPr = new Map();
  for (const record of harvest) {
    if (!byPr.has(record.pr)) byPr.set(record.pr, []);
    byPr.get(record.pr).push(record);
  }
  const records = [];
  for (const [pr, findings] of byPr) {
    const hints = await computeHints(api, { pr, mergedAt: mergedAt.get(pr), base: BASE, findings });
    for (const record of findings) {
      const { touchedAfterLastSeen, laterPrsTouchingPath } = hints.get(findingId(record));
      records.push(validateFindingRecord({ ...record, touchedAfterLastSeen, laterPrsTouchingPath }));
    }
  }
  return records;
}

/** Table cell text that cannot break its row or form a marker line. */
function cell(text) {
  return String(text)
    .replace(/\r\n|\r|\n/g, " ")
    .replaceAll("|", "\\|")
    .replaceAll("<", "&lt;");
}

function prRange(prs) {
  const first = prs[0];
  const last = prs[prs.length - 1];
  return first === last ? `PR #${first}` : `PR #${first}–#${last}`;
}

function renderTitle(prs, harvested, skipped) {
  if (harvested.length === 0) {
    return `Review follow-ups: nothing to triage from ${prRange(prs)} (${skipped.length} fixed on the PR)`;
  }
  const noun = harvested.length === 1 ? "finding" : "findings";
  return `Review follow-ups: ${harvested.length} ${noun} to triage from ${prRange(prs)}`;
}

function renderBody(prs, harvested, skipped) {
  const lines = [
    renderHarvestMarker(prs),
    "",
    "This issue was collected by `.github/workflows/harvest-review-followups.yml` and is triaged by Relay's `triage-review-followups` workflow.",
    "",
    `### Findings to triage (${harvested.length})`,
    "",
  ];
  if (harvested.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| PR | Severity | Category | Location | Description |", "| --- | --- | --- | --- | --- |");
    for (const f of harvested) {
      lines.push(
        `| #${f.pr} | ${f.severity} | ${cell(f.category)} | ${cell(`${f.path}:${f.line}`)} | ${cell(f.description)} |`,
      );
    }
  }
  lines.push("", `### Skipped — fixed on the pull request (${skipped.length})`, "");
  if (skipped.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| PR | Location | Description |", "| --- | --- | --- |");
    for (const f of skipped) {
      lines.push(`| #${f.pr} | ${cell(`${f.path}:${f.line}`)} | ${cell(f.description)} |`);
    }
  }
  lines.push("", ...[...harvested, ...skipped].map(renderFindingMarker), "");
  return `${lines.join("\n")}\n${renderHarvestBlock({ prs, findings: harvested })}`;
}

/**
 * One harvest run against `api`: the github.mjs endpoints `listIssuesWithLabel`,
 * `listIssueComments`, `listMergedPullRequests`, `listReviewThreads`, `listTreePaths`,
 * `createIssue`, `addLabels` and `closeIssue` without their `client` argument, plus the
 * four functions of `hintsApi`.
 *
 * Returns `{ pending, scanned, prs, labelOnly, harvested, skipped, stoppedAt, issue }`:
 * `pending` holds the issues that held the run back (everything else is then empty);
 * `scanned` every pull request offered to the plan; `harvested` the finding records and
 * `skipped` the findings fixed on their pull request; `issue` is `{ number }` of the
 * created issue, `{ title, bodyLength }` of the one a dry run would create, or null.
 */
export async function runHarvest(api, { minPr, dryRun }) {
  const openIssues = uniqueByNumber([
    ...(await api.listIssuesWithLabel(LABELS.harvest, "open")),
    ...(await api.listIssuesWithLabel(LABELS.issue, "open")),
  ]);
  const pending = pendingWork(openIssues);
  if (pending.length > 0) {
    return { pending, scanned: [], prs: [], labelOnly: [], harvested: [], skipped: [], stoppedAt: null, issue: null };
  }

  const ledger = computeLedger(await readLedgerIssues(api));
  const treePaths = await api.listTreePaths(BASE);

  const plan = createHarvestPlan();
  const scanned = [];
  const mergedAt = new Map();
  for (const candidate of candidatePullRequests(await api.listMergedPullRequests(BASE), { minPr })) {
    const pr = candidate.number;
    scanned.push(pr);
    mergedAt.set(pr, candidate.mergedAt);
    if (ledger.harvestedPrs.has(pr)) {
      plan.offer({ pr, alreadyRecorded: true });
      continue;
    }
    const memoryFindings = await readMemoryFindings(api, pr);
    const threads = needsThreads(pr, memoryFindings, ledger) ? await api.listReviewThreads(pr) : [];
    const { harvest, skipped } = classifyPullRequest({ pr, memoryFindings, threads, treePaths, ledger });
    if (plan.offer({ pr, alreadyRecorded: false, harvest, skipped }) === "stop") break;
  }
  const { prs, labelOnly, harvest, skipped, stoppedAt } = plan.plan();

  const harvested = await addHints(api, harvest, mergedAt);

  let draft = null;
  if (harvested.length > 0 || skipped.length > 0) {
    draft = { title: renderTitle(prs, harvested, skipped), body: renderBody(prs, harvested, skipped) };
    if (draft.body.length > MAX_BODY_LENGTH) {
      throw new Error(`the harvest issue body has ${draft.body.length} characters, more than ${MAX_BODY_LENGTH}`);
    }
  }

  const report = { pending, scanned, prs, labelOnly, harvested, skipped, stoppedAt, issue: null };
  if (dryRun) {
    if (draft !== null) report.issue = { title: draft.title, bodyLength: draft.body.length };
    return report;
  }

  if (draft !== null) {
    const recordOnly = harvested.length === 0;
    const labels = recordOnly ? [LABELS.harvest] : [LABELS.harvest, LABELS.ready];
    const { number } = await api.createIssue({ title: draft.title, body: draft.body, labels });
    if (recordOnly) await api.closeIssue(number);
    report.issue = { number };
  }
  for (const pr of [...prs, ...labelOnly].sort((a, b) => a - b)) {
    await api.addLabels(pr, [LABELS.harvested]);
  }
  return report;
}

function apiFromClient(client) {
  return {
    listIssuesWithLabel: (label, state) => listIssuesWithLabel(client, label, state),
    listIssueComments: (number) => listIssueComments(client, number),
    listMergedPullRequests: (base) => listMergedPullRequests(client, base),
    listReviewThreads: (pr) => listReviewThreads(client, pr),
    listTreePaths: (ref) => listTreePaths(client, ref),
    createIssue: (issue) => createIssue(client, issue),
    addLabels: (number, labels) => addLabels(client, number, labels),
    closeIssue: (number) => closeIssue(client, number),
    ...hintsApi(client),
  };
}

function prList(prs) {
  return prs.length === 0 ? "none" : prs.map((pr) => `#${pr}`).join(", ");
}

function findingLines(findings) {
  return findings.map((f) => `  - #${f.pr} ${f.key} ${f.path}:${f.line}`);
}

/** The report as Markdown list lines, readable as plain text too. */
function reportLines(report, dryRun) {
  let issue = "none";
  if (report.issue?.number !== undefined) issue = `created #${report.issue.number}`;
  else if (report.issue !== null)
    issue = `would create "${report.issue.title}" (${report.issue.bodyLength} characters)`;
  return [
    `- Mode: ${dryRun ? "dry run, nothing written" : "live"}`,
    `- Pending: ${prList(report.pending)}`,
    `- Scanned: ${prList(report.scanned)}`,
    `- Harvested pull requests: ${prList(report.prs)}`,
    `- Labelled only: ${prList(report.labelOnly)}`,
    `- Harvested findings: ${report.harvested.length}`,
    ...findingLines(report.harvested),
    `- Skipped findings: ${report.skipped.length}`,
    ...findingLines(report.skipped),
    `- Stopped at: ${report.stoppedAt === null ? "none" : `#${report.stoppedAt}`}`,
    `- Issue: ${issue}`,
  ];
}

/**
 * Reads HARVEST_MIN_PR and DRY_RUN from `env`, runs the harvest against `api` (built from
 * `clientFromEnv(env)` when omitted), prints the report and appends it as Markdown to
 * GITHUB_STEP_SUMMARY when that is set. Rejects on any error.
 */
export async function main(env, api) {
  const minPrText = env.HARVEST_MIN_PR;
  if (typeof minPrText !== "string" || !POSITIVE_INTEGER.test(minPrText) || !Number.isSafeInteger(Number(minPrText))) {
    throw new Error(`HARVEST_MIN_PR must be a positive integer, got ${JSON.stringify(minPrText)}`);
  }
  const dryRunText = env.DRY_RUN;
  if (dryRunText !== "true" && dryRunText !== "false") {
    throw new Error(`DRY_RUN must be "true" or "false", got ${JSON.stringify(dryRunText)}`);
  }
  const dryRun = dryRunText === "true";

  const report = await runHarvest(api ?? apiFromClient(clientFromEnv(env)), { minPr: Number(minPrText), dryRun });

  const lines = reportLines(report, dryRun);
  console.log(["Review follow-ups harvest", ...lines].join("\n"));
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, ["## Review follow-ups harvest", "", ...lines, ""].join("\n"));
  }
  return report;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.env).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
