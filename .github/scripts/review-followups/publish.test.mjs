import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { renderInputFile } from "./input-file.mjs";
import {
  computeLedger,
  findingId,
  PUBLISHER_LOGIN,
  renderEpicMarker,
  renderFindingMarker,
  renderResultMarker,
} from "./markers.mjs";
import { main, publishProposal } from "./publish.mjs";

const H = 900;
const WRITES = new Set(["createIssue", "addSubIssue", "createComment", "removeLabel", "closeIssue"]);

function key(n) {
  return n.toString(16).padStart(10, "0");
}

function entry(pr, k) {
  return {
    pr,
    key: k,
    severity: "medium",
    category: "correctness",
    path: "backend/a.ts",
    line: 3,
    anchor: "",
    description: "clipped description",
    descriptionTruncated: false,
    discussionId: "",
    threadResolved: false,
    replies: [],
    pathExists: true,
    touchedAfterLastSeen: null,
    laterPrsTouchingPath: 0,
    firstSeenSha: "",
    lastSeenSha: "",
    fullText: null,
    suggestedFix: null,
    threadReplies: [],
  };
}

function inputFor(findings) {
  return {
    version: 1,
    harvestIssue: H,
    findings: findings.map(({ pr, key: k }) => entry(pr, k)),
    prSummaries: [],
    openIssues: [],
  };
}

function draftBody({ blockedBy = "none", context = "Some context." } = {}) {
  return [
    `**Blocked by:** ${blockedBy}`,
    "",
    "## Context",
    "",
    context,
    "",
    "## Task",
    "",
    "Do it.",
    "",
    "## Touches",
    "",
    "- backend/a.ts",
    "",
    "## Scope",
    "",
    "### In scope",
    "",
    "- this",
    "",
    "### Out of scope",
    "",
    "- that",
    "",
    "## Acceptance criteria",
    "",
    "1. works",
  ].join("\n");
}

function draft(id, index, total, findings, bodyOptions) {
  const pad = (n) => String(n).padStart(2, "0");
  return {
    id,
    title: `[followups-${H} ${pad(index)}/${pad(total)}] Fix ${id}`,
    body: draftBody(bodyOptions),
    findings,
  };
}

const EPIC = { title: `[followups-${H}] Follow-ups — epic`, body: `Follow-ups of #${H}.` };

const F1 = { pr: 10, key: key(1) };
const F2 = { pr: 10, key: key(2) };
const F3 = { pr: 11, key: key(3) };
const F4 = { pr: 11, key: key(4) };
const F5 = { pr: 12, key: key(5) };

/** Three drafts a, b, c — c blocked by a and mentioning b — plus one rejection. */
function threeDraftCase() {
  const input = inputFor([F1, F2, F3, F4, F5]);
  const proposal = {
    version: 1,
    harvestIssue: H,
    epic: EPIC,
    issues: [
      draft("a", 1, 3, [F1, F2]),
      draft("b", 2, 3, [F3]),
      draft("c", 3, 3, [F4], { blockedBy: "{{draft:a}}", context: "Builds on {{draft:b}} too." }),
    ],
    rejected: [{ pr: F5.pr, key: F5.key, verdict: "invalid", reason: "Not a | bug\nat all <really>" }],
    advisories: ["Watch the queue.", "Second\nadvisory"],
  };
  return { input, proposal };
}

function singleDraftCase() {
  const input = inputFor([F1]);
  const proposal = {
    version: 1,
    harvestIssue: H,
    epic: null,
    issues: [draft("only", 1, 1, [F1])],
    rejected: [],
    advisories: [],
  };
  return { input, proposal };
}

/**
 * An in-memory GitHub: issues by number (H open with `followups:harvest` and
 * `followups:ready`), comments by issue number. It records every call in order, and
 * `failAt: [method, n]` makes the n-th call of `method` throw.
 */
function fakeApi({ issues = [], comments = [], failAt = null } = {}) {
  const calls = [];
  const state = {
    issues: new Map([
      [H, { number: H, id: H * 10, state: "open", title: "Harvest", body: "harvest", labels: ["followups:harvest", "followups:ready"] }],
    ]),
    comments: new Map([[H, [...comments]]]),
    subIssues: new Map(),
  };
  for (const issue of issues) state.issues.set(issue.number, { id: issue.number * 10, state: "open", title: "t", ...issue });
  let nextNumber = 1000;
  const counts = new Map();

  function record(method, ...args) {
    calls.push([method, ...args]);
    const count = (counts.get(method) ?? 0) + 1;
    counts.set(method, count);
    if (failAt !== null && failAt[0] === method && failAt[1] === count) throw new Error(`${method} failed`);
  }

  function requireIssue(number) {
    const issue = state.issues.get(number);
    if (issue === undefined) throw new Error(`no issue #${number}`);
    return issue;
  }

  const api = {
    async listIssuesWithLabel(label, stateFilter) {
      record("listIssuesWithLabel", label, stateFilter);
      return [...state.issues.values()]
        .filter((issue) => issue.labels.includes(label) && (stateFilter === "all" || issue.state === "open"))
        .map((issue) => ({ ...issue }));
    },
    async getIssue(number) {
      record("getIssue", number);
      return { ...requireIssue(number) };
    },
    async listIssueComments(number) {
      record("listIssueComments", number);
      return (state.comments.get(number) ?? []).map((comment) => ({ ...comment }));
    },
    async createIssue({ title, body, labels }) {
      record("createIssue", { title, body, labels });
      const number = nextNumber++;
      state.issues.set(number, { number, id: number * 10 + 7, state: "open", title, body, labels: [...labels] });
      return { number, id: number * 10 + 7 };
    },
    async addSubIssue(parentNumber, childId) {
      record("addSubIssue", parentNumber, childId);
      requireIssue(parentNumber);
      state.subIssues.set(childId, parentNumber);
    },
    async createComment(number, body) {
      record("createComment", number, body);
      requireIssue(number);
      state.comments.get(number).push({ id: 1, author: PUBLISHER_LOGIN, createdAt: "2026-09-26T00:00:00Z", body });
      return { id: 1 };
    },
    async removeLabel(number, label) {
      record("removeLabel", number, label);
      const issue = requireIssue(number);
      issue.labels = issue.labels.filter((existing) => existing !== label);
    },
    async closeIssue(number) {
      record("closeIssue", number);
      requireIssue(number).state = "closed";
    },
  };
  return { api, calls, state };
}

function writes(calls) {
  return calls.filter(([method]) => WRITES.has(method));
}

function silence(t) {
  const logs = [];
  t.mock.method(console, "log", (line) => logs.push(line));
  return logs;
}

/** The ledger over the fake's current state, as `computeLedger` sees GitHub. */
function ledgerOf(state) {
  return computeLedger(
    [...state.issues.values()].map(({ number, labels, body }) => ({
      number,
      labels,
      body,
      comments: (state.comments.get(number) ?? []).map(({ author, body: text }) => ({ author, body: text })),
    })),
  );
}

// 1. Nothing is written for an invalid, stale or oversized proposal.

test("an invalid proposal rejects with its violations and writes nothing", async () => {
  const { input, proposal } = singleDraftCase();
  const { api, calls } = fakeApi();
  await assert.rejects(publishProposal(api, { input, proposal: { ...proposal, advisories: "x" } }), /invalid:\n- .*advisories/);
  assert.deepEqual(calls, []);
});

test("a draft mentioning a later draft rejects and writes nothing", async () => {
  const input = inputFor([F1, F2]);
  const proposal = {
    version: 1,
    harvestIssue: H,
    epic: EPIC,
    issues: [draft("a", 1, 2, [F1], { context: "See {{draft:b}}." }), draft("b", 2, 2, [F2])],
    rejected: [],
    advisories: [],
  };
  const { api, calls } = fakeApi();
  await assert.rejects(publishProposal(api, { input, proposal }), /draft "a" references "\{\{draft:b\}\}", which does not come earlier/);
  assert.deepEqual(calls, []);
});

test("a finding already in a followups:issue body makes the proposal stale; nothing is written", async () => {
  const { input, proposal } = threeDraftCase();
  const { api, calls } = fakeApi({
    issues: [{ number: 50, state: "closed", labels: ["followups:issue"], body: `old\n\n${renderFindingMarker(F3)}` }],
  });
  await assert.rejects(publishProposal(api, { input, proposal }), /stale, restart from prepare: already published \(pr 11, key 0000000003\)/);
  assert.deepEqual(writes(calls), []);
});

test("a rejection already in a triage-result comment makes the proposal stale; nothing is written", async () => {
  const { input, proposal } = threeDraftCase();
  const comment = { id: 1, author: PUBLISHER_LOGIN, createdAt: "x", body: `${renderResultMarker(H)}\n${renderFindingMarker(F5)}\n` };
  const { api, calls } = fakeApi({ comments: [comment] });
  await assert.rejects(publishProposal(api, { input, proposal }), /stale/);
  assert.deepEqual(writes(calls), []);
});

test("a result comment over 60,000 characters rejects and writes nothing", async () => {
  const findings = Array.from({ length: 70 }, (_, i) => ({ pr: 20, key: key(100 + i) }));
  const input = inputFor(findings);
  const proposal = {
    version: 1,
    harvestIssue: H,
    epic: null,
    issues: [],
    rejected: findings.map(({ pr, key: k }) => ({ pr, key: k, verdict: "not-worth", reason: "r".repeat(5000) })),
    advisories: [],
  };
  const { api, calls } = fakeApi();
  await assert.rejects(publishProposal(api, { input, proposal }), /triage-result comment would be \d+ characters, over the 60000 limit/);
  assert.deepEqual(writes(calls), []);
});

test("a result comment that fits because reasons are clipped to 1,000 characters is posted", async (t) => {
  silence(t);
  const findings = Array.from({ length: 40 }, (_, i) => ({ pr: 20, key: key(100 + i) }));
  const input = inputFor(findings);
  const proposal = {
    version: 1,
    harvestIssue: H,
    epic: null,
    issues: [],
    rejected: findings.map(({ pr, key: k }) => ({ pr, key: k, verdict: "not-worth", reason: `${"r".repeat(1000)}TAIL` })),
    advisories: [],
  };
  const { api, calls } = fakeApi();
  await publishProposal(api, { input, proposal });
  const [, , body] = calls.find(([method]) => method === "createComment");
  assert.ok(body.includes(`| ${"r".repeat(1000)} |`));
  assert.ok(!body.includes("TAIL"));
});

// 2–3. Order, placeholders, labels and markers.

test("the epic, then a, b and c are created in order, each linked after it exists", async (t) => {
  const logs = silence(t);
  const { input, proposal } = threeDraftCase();
  const { api, calls, state } = fakeApi();
  const result = await publishProposal(api, { input, proposal });

  const sequence = writes(calls).map(([method, arg1, arg2]) =>
    method === "createIssue" ? `createIssue ${arg1.title}` : `${method} ${arg1}${arg2 === undefined ? "" : ` ${typeof arg2 === "string" && arg2.length > 40 ? "<comment>" : arg2}`}`,
  );
  assert.deepEqual(sequence, [
    `createIssue ${EPIC.title}`,
    `createIssue ${proposal.issues[0].title}`,
    "addSubIssue 1000 10017",
    `createIssue ${proposal.issues[1].title}`,
    "addSubIssue 1000 10027",
    `createIssue ${proposal.issues[2].title}`,
    "addSubIssue 1000 10037",
    `createComment ${H} <comment>`,
    `removeLabel ${H} followups:ready`,
    `closeIssue ${H}`,
  ]);
  assert.deepEqual(result, {
    epic: 1000,
    created: [
      { id: "a", number: 1001 },
      { id: "b", number: 1002 },
      { id: "c", number: 1003 },
    ],
    rejected: 1,
  });

  const c = state.issues.get(1003).body;
  assert.ok(c.startsWith("**Blocked by:** #1001\n"));
  assert.ok(c.includes("Builds on #1002 too."));
  assert.ok(!c.includes("{{draft:"));
  assert.deepEqual(logs, proposal.issues.map((d, i) => `created #${1001 + i} ${d.title}`));
});

test("each created issue carries exactly its labels and ends with its markers; the epic ends with the epic marker", async (t) => {
  silence(t);
  const { input, proposal } = threeDraftCase();
  const { api, state } = fakeApi();
  await publishProposal(api, { input, proposal });

  const epic = state.issues.get(1000);
  assert.deepEqual(epic.labels, ["followups:issue"]);
  assert.equal(epic.body, `${EPIC.body}\n\n${renderEpicMarker(H)}`);

  proposal.issues.forEach((d, i) => {
    const issue = state.issues.get(1001 + i);
    assert.deepEqual(issue.labels, ["followups:issue", "spec:proposed"]);
    assert.equal(issue.title, d.title);
    const markers = d.findings.map(renderFindingMarker).join("\n");
    assert.ok(issue.body.endsWith(`\n\n${markers}`), `draft ${d.id}`);
  });
  assert.equal(state.issues.get(1001).body, `${proposal.issues[0].body}\n\n${renderFindingMarker(F1)}\n${renderFindingMarker(F2)}`);
});

// 4–5. Epic reuse and no epic.

test("an epic the ledger already knows for H is reused, not created", async (t) => {
  silence(t);
  const { input, proposal } = threeDraftCase();
  const { api, calls } = fakeApi({
    issues: [{ number: 77, labels: ["followups:issue"], body: `Earlier epic\n\n${renderEpicMarker(H)}` }],
  });
  const result = await publishProposal(api, { input, proposal });

  const created = calls.filter(([method]) => method === "createIssue").map(([, fields]) => fields.title);
  assert.deepEqual(created, proposal.issues.map((d) => d.title));
  assert.deepEqual(
    calls.filter(([method]) => method === "addSubIssue"),
    [
      ["addSubIssue", 77, 10007],
      ["addSubIssue", 77, 10017],
      ["addSubIssue", 77, 10027],
    ],
  );
  assert.equal(result.epic, 77);
});

test("a single draft without an epic creates no epic and links nothing", async (t) => {
  silence(t);
  const { input, proposal } = singleDraftCase();
  const { api, calls } = fakeApi();
  const result = await publishProposal(api, { input, proposal });

  assert.equal(calls.filter(([method]) => method === "createIssue").length, 1);
  assert.equal(calls.filter(([method]) => method === "addSubIssue").length, 0);
  assert.deepEqual(result, { epic: null, created: [{ id: "only", number: 1000 }], rejected: 0 });
});

// 6–7. The result comment.

test("the result comment lists issues, rejections, markers and advisories, and makes every finding terminal", async (t) => {
  silence(t);
  const { input, proposal } = threeDraftCase();
  const { api, state } = fakeApi();
  await publishProposal(api, { input, proposal });

  const [comment] = state.comments.get(H);
  const lines = comment.body.split("\n");
  assert.equal(lines[0], renderResultMarker(H));
  assert.ok(lines.includes("### Triage result"));
  assert.ok(lines.includes("Epic: #1000"));
  proposal.issues.forEach((d, i) => assert.ok(lines.includes(`- #${1001 + i} ${d.title}`)));
  assert.ok(lines.includes("#### Rejected (1)"));
  assert.ok(lines.includes(`| #12 | ${F5.key} | invalid | Not a \\| bug at all &lt;really> |  |`));
  assert.equal(lines.filter((line) => line === renderFindingMarker(F5)).length, 1);
  assert.ok(lines.includes("#### Advisories"));
  assert.ok(lines.includes("- Watch the queue."));
  assert.ok(lines.includes("- Second advisory"));

  const { terminal } = ledgerOf(state);
  for (const finding of [F1, F2, F3, F4, F5]) assert.ok(terminal.has(findingId(finding)), findingId(finding));
});

test("an already-tracked rejection shows its trackedBy; no rejections and no advisories read None.", async (t) => {
  silence(t);
  const tracked = { ...singleDraftCase(), input: inputFor([F1, F2]) };
  tracked.proposal.rejected = [{ pr: F2.pr, key: F2.key, verdict: "already-tracked", reason: "dup", trackedBy: 42 }];
  const first = fakeApi();
  await publishProposal(first.api, tracked);
  const trackedBody = first.state.comments.get(H)[0].body;
  assert.ok(trackedBody.includes(`| #10 | ${F2.key} | already-tracked | dup | #42 |`));
  assert.ok(!trackedBody.includes("Epic:"));

  const plain = singleDraftCase();
  const second = fakeApi();
  await publishProposal(second.api, plain);
  const body = second.state.comments.get(H)[0].body;
  assert.ok(body.includes("#### Rejected (0)\n\nNone."));
  assert.ok(body.includes("#### Advisories\n\nNone."));
  assert.ok(!body.includes("crb-followup:v1"));
});

test("a proposal with no drafts and no rejections posts no comment and still closes H", async (t) => {
  silence(t);
  const input = inputFor([]);
  const proposal = { version: 1, harvestIssue: H, epic: null, issues: [], rejected: [], advisories: ["note"] };
  const { api, calls, state } = fakeApi();
  const result = await publishProposal(api, { input, proposal });

  assert.deepEqual(writes(calls), [
    ["removeLabel", H, "followups:ready"],
    ["closeIssue", H],
  ]);
  assert.equal(state.issues.get(H).state, "closed");
  assert.deepEqual(state.issues.get(H).labels, ["followups:harvest"]);
  assert.deepEqual(result, { epic: null, created: [], rejected: 0 });
});

// 8. Failure mid-run.

test("a failing createIssue for the second draft leaves the epic and first issue, and H open with followups:ready", async (t) => {
  const logs = silence(t);
  const { input, proposal } = threeDraftCase();
  const { api, calls, state } = fakeApi({ failAt: ["createIssue", 3] });
  await assert.rejects(publishProposal(api, { input, proposal }), /createIssue failed/);

  assert.equal(calls.filter(([method]) => method === "createIssue").length, 3);
  assert.deepEqual(state.issues.get(1001).labels, ["followups:issue", "spec:proposed"]);
  assert.equal(state.issues.has(1002), false);
  assert.deepEqual(logs, [`created #1001 ${proposal.issues[0].title}`]);
  assert.deepEqual(state.comments.get(H), []);
  assert.equal(state.issues.get(H).state, "open");
  assert.deepEqual(state.issues.get(H).labels, ["followups:harvest", "followups:ready"]);
});

test("a failing second createIssue leaves the first issue, and H open with followups:ready", async (t) => {
  silence(t);
  const input = inputFor([F1, F2]);
  const proposal = {
    version: 1,
    harvestIssue: H,
    epic: EPIC,
    issues: [draft("a", 1, 2, [F1]), draft("b", 2, 2, [F2])],
    rejected: [],
    advisories: [],
  };
  const { api, calls, state } = fakeApi({
    issues: [{ number: 77, labels: ["followups:issue"], body: renderEpicMarker(H) }],
    failAt: ["createIssue", 2],
  });
  await assert.rejects(publishProposal(api, { input, proposal }), /createIssue failed/);
  assert.equal(state.issues.get(1000).title, proposal.issues[0].title);
  assert.deepEqual(calls.filter(([method]) => method === "addSubIssue"), [["addSubIssue", 77, 10007]]);
  assert.equal(state.issues.get(H).state, "open");
  assert.ok(state.issues.get(H).labels.includes("followups:ready"));
});

// 9. The CLI.

function tempFiles(t, files) {
  const dir = mkdtempSync(path.join(tmpdir(), "publish-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = {};
  for (const [name, text] of Object.entries(files)) {
    paths[name] = path.join(dir, name);
    writeFileSync(paths[name], text);
  }
  return paths;
}

test("main publishes a valid pair, prints each created issue and the summary, and exits 0", async (t) => {
  const logs = silence(t);
  const { input, proposal } = threeDraftCase();
  const files = tempFiles(t, { "input.json": renderInputFile(input), "proposal.json": JSON.stringify(proposal) });
  const { api, state } = fakeApi();

  const code = await main(["--input", files["input.json"], "--proposal", files["proposal.json"]], api);
  assert.equal(code, 0);
  assert.deepEqual(logs, [
    ...proposal.issues.map((d, i) => `created #${1001 + i} ${d.title}`),
    JSON.stringify({ epic: 1000, created: [{ id: "a", number: 1001 }, { id: "b", number: 1002 }, { id: "c", number: 1003 }], rejected: 1 }),
  ]);
  assert.equal(state.issues.get(H).state, "closed");
});

test("main exits 1 without calling the api on a missing argument or an unparsable file", async (t) => {
  const errors = [];
  t.mock.method(console, "error", (error) => errors.push(error));
  const { input, proposal } = singleDraftCase();
  const files = tempFiles(t, {
    "input.json": renderInputFile(input),
    "proposal.json": JSON.stringify(proposal),
    "broken.json": "{ not json",
  });
  const { api, calls } = fakeApi();

  const cases = [
    [],
    ["--input", files["input.json"]],
    ["--input", files["input.json"], "--proposal"],
    ["--input", files["input.json"], "--proposal", files["proposal.json"], "--extra", "x"],
    ["--input", files["broken.json"], "--proposal", files["proposal.json"]],
    ["--input", files["input.json"], "--proposal", files["broken.json"]],
    ["--input", files["input.json"], "--proposal", path.join(path.dirname(files["input.json"]), "missing.json")],
  ];
  for (const argv of cases) {
    assert.equal(await main(argv, api), 1, JSON.stringify(argv));
  }
  assert.equal(errors.length, cases.length);
  assert.deepEqual(calls, []);
});

test("main exits 1 after printing what it already created when the api fails", async (t) => {
  const logs = silence(t);
  t.mock.method(console, "error", () => {});
  const { input, proposal } = threeDraftCase();
  const files = tempFiles(t, { "input.json": renderInputFile(input), "proposal.json": JSON.stringify(proposal) });
  const { api } = fakeApi({ failAt: ["addSubIssue", 2] });

  assert.equal(await main(["--input", files["input.json"], "--proposal", files["proposal.json"]], api), 1);
  assert.deepEqual(logs, [
    `created #1001 ${proposal.issues[0].title}`,
    `created #1002 ${proposal.issues[1].title}`,
  ]);
});
