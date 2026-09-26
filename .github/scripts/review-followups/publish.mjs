/**
 * The triage workflow's `publish` step of the review follow-ups pipeline
 * (docs/adr/2026-09-26-merged-review-findings-become-proposed-follow-up-issues.md).
 *
 *   node publish.mjs --input <input.json> --proposal <proposal.json>
 *
 * Turns a triage proposal (validate.mjs) for harvest issue H into GitHub state, through
 * github.mjs (`clientFromEnv`: GITHUB_API_URL, GITHUB_GRAPHQL_URL, GITHUB_TOKEN,
 * GITHUB_REPOSITORY). It writes nothing until every check has passed:
 *
 *   - the proposal is valid against the input file (`validateProposal`), and no draft
 *     body mentions a `{{draft:<id>}}` that is not created before it;
 *   - no `(pr, key)` of the proposal is already in the terminal ledger (`computeLedger`
 *     over every `followups:issue` issue and H with its comments) — the proposal is
 *     stale, and the run must restart from `prepare`;
 *   - the triage-result comment, rendered with every issue number as `#999999`, fits in
 *     60,000 characters.
 *
 * Then it writes, in this order:
 *
 *   1. the epic, when the proposal has one: reused when the ledger already knows an
 *      epic for H, otherwise created labelled `followups:issue`, its body ending with
 *      the epic marker for H;
 *   2. each draft, in array order: `{{draft:<id>}}` replaced by the created issue's
 *      `#<number>`, its body ending with one finding marker per finding, created
 *      labelled `followups:issue` and `spec:proposed`, printed as
 *      `created #<number> <title>`, then linked as a sub-issue of the epic;
 *   3. the triage-result comment on H, carrying the result marker and a finding marker
 *      per rejected finding, when there is at least one draft or rejection;
 *   4. `followups:ready` removed from H, and H closed as completed.
 *
 * Why a failure may restart from `prepare`: every write that publishes a finding
 * carries that finding's marker in the same write, so the terminal ledger is exactly
 * what has been published. `prepare` drops those findings, the next proposal holds only
 * the rest, and the epic is found again by its marker instead of being created twice.
 * H stays open with `followups:ready` until step 4, so an interrupted run is still
 * visible and still prepared from. Two things a restart does not repair: a failure
 * between creating a draft's issue and linking it to the epic leaves that issue
 * unlinked, and an epic created before the failure stays as it is when the restarted
 * proposal has no epic; the maintainer tidies either by hand. Failed calls are never
 * retried here.
 *
 * Nothing here labels an issue `spec:approved` or `agent:ready`; that is always a human.
 *
 * Prints each created issue as it goes, then the returned summary as JSON, and exits 0.
 * A missing argument, an unreadable or unparsable file, or any other error exits 1,
 * after whatever was already printed.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  addSubIssue,
  clientFromEnv,
  closeIssue,
  createComment,
  createIssue,
  getIssue,
  listIssueComments,
  listIssuesWithLabel,
  removeLabel,
} from "./github.mjs";
import { parseInputFile } from "./input-file.mjs";
import {
  computeLedger,
  findingId,
  LABELS,
  renderEpicMarker,
  renderFindingMarker,
  renderResultMarker,
} from "./markers.mjs";
import { validateProposal } from "./validate.mjs";

const MAX_COMMENT = 60000;
const MAX_REASON = 1000;
const PLACEHOLDER_NUMBER = 999999;
const PLACEHOLDER = /\{\{draft:([^}]*)\}\}/g;

/** A table cell: `|` escaped, newlines as spaces, `<` as `&lt;`. */
function cell(text) {
  return text.replace(/\|/g, "\\|").replace(/\r?\n|\r/g, " ").replace(/</g, "&lt;");
}

/** One line of text, so nothing in it can form a marker line of its own. */
function oneLine(text) {
  return text.replace(/\r?\n|\r/g, " ");
}

/**
 * The triage-result comment on H. `created` is `{ number, title }[]`; `epic` is a
 * number or null.
 */
function renderResultComment(harvestIssue, { epic, created, rejected, advisories }) {
  const lines = [renderResultMarker(harvestIssue), "### Triage result", ""];
  if (epic !== null) lines.push(`Epic: #${epic}`, "");
  if (created.length > 0) {
    for (const { number, title } of created) lines.push(`- #${number} ${oneLine(title)}`);
    lines.push("");
  }

  lines.push(`#### Rejected (${rejected.length})`, "");
  if (rejected.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| PR | Key | Verdict | Reason | Tracked by |", "| --- | --- | --- | --- | --- |");
    for (const { pr, key, verdict, reason, trackedBy } of rejected) {
      const tracked = trackedBy === undefined ? "" : `#${trackedBy}`;
      lines.push(`| #${pr} | ${key} | ${cell(verdict)} | ${cell(reason.slice(0, MAX_REASON))} | ${tracked} |`);
    }
    lines.push("");
    for (const finding of rejected) lines.push(renderFindingMarker(finding));
  }
  lines.push("");

  lines.push("#### Advisories", "");
  if (advisories.length === 0) {
    lines.push("None.");
  } else {
    for (const advisory of advisories) lines.push(`- ${oneLine(advisory)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Violations for a `{{draft:<id>}}` that names a draft not created before this one. */
function forwardReferences(drafts) {
  const violations = [];
  const earlier = new Set();
  for (const draft of drafts) {
    for (const [, id] of draft.body.matchAll(PLACEHOLDER)) {
      if (!earlier.has(id)) violations.push(`draft "${draft.id}" references "{{draft:${id}}}", which does not come earlier`);
    }
    earlier.add(draft.id);
  }
  return violations;
}

async function readLedger(api, harvestIssue) {
  const followups = await api.listIssuesWithLabel(LABELS.issue, "all");
  const harvest = await api.getIssue(harvestIssue);
  const comments = await api.listIssueComments(harvestIssue);
  return computeLedger([
    ...followups.map(({ number, labels, body }) => ({ number, labels, body, comments: [] })),
    {
      number: harvest.number,
      labels: harvest.labels,
      body: harvest.body,
      comments: comments.map(({ author, body }) => ({ author, body })),
    },
  ]);
}

/** Throws, listing every violation, unless `proposal` is a publishable proposal for `input`. */
function checkProposal(input, proposal) {
  const violations = validateProposal(input, proposal);
  if (violations.length === 0) violations.push(...forwardReferences(proposal.issues));
  if (violations.length > 0) {
    throw new Error(`the proposal is invalid:\n${violations.map((violation) => `- ${violation}`).join("\n")}`);
  }
}

/**
 * Publishes `proposal` for the parsed triage input file `input`, in the order described
 * in this module's header. `api` holds `listIssuesWithLabel(label, state)`,
 * `getIssue(number)`, `listIssueComments(number)`, `createIssue({ title, body, labels })`,
 * `addSubIssue(parentNumber, childId)`, `createComment(number, body)`,
 * `removeLabel(number, label)` and `closeIssue(number)`, the github.mjs endpoints of the
 * same names bound to a client.
 *
 * Rejects without writing when the proposal is invalid, stale or its result comment too
 * long; any error from `api` rejects the call and leaves the writes before it in place.
 * Returns `{ epic, created: [{ id, number }], rejected }`: the epic's issue number or
 * null, the draft ids with their issue numbers, and the number of rejections.
 */
export async function publishProposal(api, { input, proposal }) {
  checkProposal(input, proposal);
  const harvestIssue = proposal.harvestIssue;

  const ledger = await readLedger(api, harvestIssue);
  const published = [...proposal.issues.flatMap((draft) => draft.findings), ...proposal.rejected].filter((finding) =>
    ledger.terminal.has(findingId(finding)),
  );
  if (published.length > 0) {
    const list = published.map(({ pr, key }) => `(pr ${pr}, key ${key})`).join(", ");
    throw new Error(`the proposal is stale, restart from prepare: already published ${list}`);
  }

  const renderComment = (epic, created) =>
    renderResultComment(harvestIssue, { epic, created, rejected: proposal.rejected, advisories: proposal.advisories });
  const longest = renderComment(
    proposal.epic === null ? null : PLACEHOLDER_NUMBER,
    proposal.issues.map(({ title }) => ({ number: PLACEHOLDER_NUMBER, title })),
  );
  if (longest.length > MAX_COMMENT) {
    throw new Error(`the triage-result comment would be ${longest.length} characters, over the ${MAX_COMMENT} limit`);
  }

  let epic = null;
  if (proposal.epic !== null) {
    epic = ledger.epics.get(harvestIssue) ?? null;
    if (epic === null) {
      const created = await api.createIssue({
        title: proposal.epic.title,
        body: `${proposal.epic.body}\n\n${renderEpicMarker(harvestIssue)}`,
        labels: [LABELS.issue],
      });
      epic = created.number;
    }
  }

  const numbers = new Map();
  const created = [];
  for (const draft of proposal.issues) {
    const body = draft.body.replace(PLACEHOLDER, (_, id) => `#${numbers.get(id)}`);
    const markers = draft.findings.map(renderFindingMarker).join("\n");
    const issue = await api.createIssue({
      title: draft.title,
      body: `${body}\n\n${markers}`,
      labels: [LABELS.issue, LABELS.proposed],
    });
    numbers.set(draft.id, issue.number);
    created.push({ id: draft.id, number: issue.number, title: draft.title });
    console.log(`created #${issue.number} ${draft.title}`);
    if (epic !== null) await api.addSubIssue(epic, issue.id);
  }

  if (proposal.issues.length > 0 || proposal.rejected.length > 0) {
    await api.createComment(harvestIssue, renderComment(epic, created));
  }

  await api.removeLabel(harvestIssue, LABELS.ready);
  await api.closeIssue(harvestIssue);

  return { epic, created: created.map(({ id, number }) => ({ id, number })), rejected: proposal.rejected.length };
}

function apiFromClient(client) {
  return {
    listIssuesWithLabel: (label, state) => listIssuesWithLabel(client, label, state),
    getIssue: (number) => getIssue(client, number),
    listIssueComments: (number) => listIssueComments(client, number),
    createIssue: (fields) => createIssue(client, fields),
    addSubIssue: (parentNumber, childId) => addSubIssue(client, parentNumber, childId),
    createComment: (number, body) => createComment(client, number, body),
    removeLabel: (number, label) => removeLabel(client, number, label),
    closeIssue: (number) => closeIssue(client, number),
  };
}

function parseArgs(argv) {
  const usage = "usage: node publish.mjs --input <input.json> --proposal <proposal.json>";
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const [name, value] = [argv[i], argv[i + 1]];
    if (name !== "--input" && name !== "--proposal") throw new Error(`unknown argument "${name}"; ${usage}`);
    if (values.has(name)) throw new Error(`${name} is given twice; ${usage}`);
    if (value === undefined || value === "") throw new Error(`${name} needs a value; ${usage}`);
    values.set(name, value);
  }
  const input = values.get("--input");
  const proposal = values.get("--proposal");
  if (input === undefined || proposal === undefined) throw new Error(usage);
  return { input, proposal };
}

/**
 * Runs the step for `argv` (without the node and script paths) and resolves to the exit
 * code: 0 when the proposal was published, 1 on any error, which is printed to stderr.
 * `api` defaults to one built from `clientFromEnv`.
 */
export async function main(argv, api) {
  try {
    const files = parseArgs(argv);
    const input = parseInputFile(await readFile(files.input, "utf8"));
    const proposal = JSON.parse(await readFile(files.proposal, "utf8"));
    // Checked at the read site, so an invalid proposal is reported before the GitHub client is built.
    checkProposal(input, proposal);
    const summary = await publishProposal(api ?? apiFromClient(clientFromEnv()), { input, proposal });
    console.log(JSON.stringify(summary));
    return 0;
  } catch (error) {
    console.error(error);
    return 1;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
