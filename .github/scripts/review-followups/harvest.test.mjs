import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { main, runHarvest } from "./harvest.mjs";
import {
  LABELS,
  parseFindingMarkers,
  parseHarvestMarker,
  renderFindingMarker,
  renderHarvestMarker,
} from "./markers.mjs";
import { parseHarvestBlock } from "./records.mjs";

const REVIEW_BOT = "github-actions[bot]";
const MERGED_AT = "2026-09-01T00:00:00Z";
const WRITES = new Set(["createIssue", "addLabels", "closeIssue"]);

function key(n) {
  return n.toString(16).padStart(10, "0");
}

/** A raw memory finding as the review bot stores it. */
function memoryFinding(n, overrides = {}) {
  return {
    key: key(n),
    path: `backend/src/file${n}.ts`,
    line: n,
    severity: "medium",
    category: "correctness",
    description: `Finding ${n} is wrong.`,
    anchor: "",
    status: "open",
    discussion_id: "",
    first_seen_sha: "",
    last_seen_sha: "",
    ...overrides,
  };
}

function memoryComment(pr, findings) {
  const payload = deflateSync(Buffer.from(JSON.stringify({ version: 1, pr_number: pr, findings }))).toString("base64");
  return {
    id: pr * 10,
    author: REVIEW_BOT,
    createdAt: MERGED_AT,
    body: `Review memory\n<!-- crb-memory:v1:z:${payload} -->`,
  };
}

/**
 * An in-memory `api`. `issues` are `{ number, state, labels, body, comments? }`, `pulls`
 * are `{ number, labels? }` merged into develop, `memories` maps a pull request to its raw
 * memory findings, `prComments` overrides a pull request's comments, `threads` maps a
 * pull request to its review threads, `pathCommits` maps a path to the SHAs touching it
 * on develop and `commitPrs` a SHA to pull request numbers. Every call is recorded in
 * `calls`, and writes also in `writes`.
 */
function fakeApi({
  issues = [],
  pulls = [],
  memories = {},
  prComments = {},
  threads = {},
  tree = [],
  pathCommits = {},
  commitPrs = {},
  failCreate = false,
} = {}) {
  const calls = [];
  const writes = [];
  const record = (name, ...args) => {
    calls.push({ name, args });
    if (WRITES.has(name)) writes.push({ name, args });
  };
  const issueList = issues.map((issue) => ({ title: `Issue ${issue.number}`, comments: [], ...issue }));
  return {
    calls,
    writes,
    called: (name, arg) => calls.some((call) => call.name === name && (arg === undefined || call.args[0] === arg)),
    async listIssuesWithLabel(label, state) {
      record("listIssuesWithLabel", label, state);
      return issueList
        .filter((issue) => issue.labels.includes(label) && (state === "all" || issue.state === state))
        .map(({ comments: _comments, ...issue }) => issue);
    },
    async listIssueComments(number) {
      record("listIssueComments", number);
      const issue = issueList.find((candidate) => candidate.number === number);
      if (issue) return issue.comments;
      if (prComments[number]) return prComments[number];
      return memories[number] ? [memoryComment(number, memories[number])] : [];
    },
    async listMergedPullRequests(base) {
      record("listMergedPullRequests", base);
      return pulls.map(({ number, labels = [] }) => ({ number, mergedAt: MERGED_AT, labels }));
    },
    async listReviewThreads(pr) {
      record("listReviewThreads", pr);
      return threads[pr] ?? [];
    },
    async listTreePaths(ref) {
      record("listTreePaths", ref);
      return new Set(tree);
    },
    async createIssue(issue) {
      record("createIssue", issue);
      if (failCreate) throw new Error("POST issues failed (500)");
      return { number: 900, id: 9000 };
    },
    async addLabels(number, labels) {
      record("addLabels", number, labels);
    },
    async closeIssue(number) {
      record("closeIssue", number);
    },
    async listPullRequestCommits(pr) {
      record("listPullRequestCommits", pr);
      return [];
    },
    async getCommitFiles(sha) {
      record("getCommitFiles", sha);
      return [];
    },
    async listCommitsTouchingPath(options) {
      record("listCommitsTouchingPath", options);
      return pathCommits[options.path] ?? [];
    },
    async listPullRequestsForCommit(sha) {
      record("listPullRequestsForCommit", sha);
      return (commitPrs[sha] ?? []).map((number) => ({ number, mergedAt: MERGED_AT }));
    },
  };
}

function findings(from, count, overrides) {
  return Array.from({ length: count }, (_, i) => memoryFinding(from + i, overrides));
}

function created(api) {
  return api.writes.find((write) => write.name === "createIssue")?.args[0];
}

function labelledPrs(api) {
  return api.writes.filter((write) => write.name === "addLabels").map((write) => write.args[0]);
}

const live = { minPr: 10, dryRun: false };

test("an open harvest issue holds the run back with no call beyond the open listings", async () => {
  const api = fakeApi({
    issues: [{ number: 7, state: "open", labels: [LABELS.harvest], body: "" }],
    pulls: [{ number: 20 }],
    memories: { 20: findings(1, 1) },
  });
  const report = await runHarvest(api, live);
  assert.deepEqual(report.pending, [7]);
  assert.equal(report.issue, null);
  assert.deepEqual(api.calls, [
    { name: "listIssuesWithLabel", args: [LABELS.harvest, "open"] },
    { name: "listIssuesWithLabel", args: [LABELS.issue, "open"] },
  ]);
});

test("an open proposed follow-up issue holds the run back; one without spec:proposed does not", async () => {
  const blocked = fakeApi({
    issues: [{ number: 8, state: "open", labels: [LABELS.issue, LABELS.proposed], body: "" }],
  });
  assert.deepEqual((await runHarvest(blocked, live)).pending, [8]);
  assert.equal(blocked.calls.length, 2);

  const free = fakeApi({ issues: [{ number: 9, state: "open", labels: [LABELS.issue], body: "" }] });
  const report = await runHarvest(free, live);
  assert.deepEqual(report.pending, []);
  assert.ok(free.called("listMergedPullRequests", "develop"));
});

test("pull requests below minPr or already labelled followups:harvested are never read", async () => {
  const api = fakeApi({
    pulls: [{ number: 5 }, { number: 11, labels: [LABELS.harvested] }, { number: 12 }],
    memories: { 5: findings(1, 1), 11: findings(2, 1), 12: findings(3, 1) },
  });
  const report = await runHarvest(api, live);
  assert.deepEqual(report.scanned, [12]);
  for (const pr of [5, 11]) {
    assert.ok(!api.calls.some((call) => call.args[0] === pr), `#${pr} was read`);
    assert.ok(!labelledPrs(api).includes(pr));
  }
});

test("an undecodable trusted memory rejects the run naming the pull request, before any write", async () => {
  const api = fakeApi({
    pulls: [{ number: 12 }, { number: 13 }],
    memories: { 12: findings(1, 1) },
    prComments: { 13: [{ id: 1, author: REVIEW_BOT, createdAt: MERGED_AT, body: "<!-- crb-memory:v1:z:!!!! -->" }] },
  });
  await assert.rejects(runHarvest(api, live), /#13/);
  assert.deepEqual(api.writes, []);
});

test("the cap takes the first two pull requests' 27 findings and leaves the third unlabelled", async () => {
  const api = fakeApi({
    pulls: [{ number: 20 }, { number: 21 }, { number: 22 }],
    memories: { 20: findings(100, 12), 21: findings(200, 15), 22: findings(300, 5) },
  });
  const report = await runHarvest(api, live);

  const issue = created(api);
  assert.deepEqual(issue.labels, [LABELS.harvest, LABELS.ready]);
  assert.equal(issue.title, "Review follow-ups: 27 findings to triage from PR #20–#21");
  assert.equal(report.harvested.length, 27);
  assert.deepEqual([...new Set(parseHarvestBlock(issue.body).findings.map((f) => f.pr))], [20, 21]);
  assert.deepEqual(labelledPrs(api), [20, 21]);
  assert.equal(report.stoppedAt, 22);
  assert.deepEqual(report.issue, { number: 900 });
  assert.ok(!api.called("listPullRequestCommits", 22));
  assert.ok(!api.calls.some((call) => call.name === "listCommitsTouchingPath" && call.args[0].path.includes("file3")));
  assert.ok(!api.called("listReviewThreads"), "no finding had a numeric thread id");
});

test("a single pull request with one finding is titled from that pull request", async () => {
  const api = fakeApi({ pulls: [{ number: 20 }], memories: { 20: findings(1, 1) } });
  await runHarvest(api, live);
  assert.equal(created(api).title, "Review follow-ups: 1 finding to triage from PR #20");
});

test("the issue is created before any pull request is labelled", async () => {
  const api = fakeApi({ pulls: [{ number: 20 }, { number: 21 }], memories: { 20: findings(1, 2) } });
  await runHarvest(api, live);
  assert.deepEqual(
    api.writes.map((write) => write.name),
    ["createIssue", "addLabels", "addLabels"],
  );
});

test("a failed createIssue labels no pull request", async () => {
  const api = fakeApi({ pulls: [{ number: 20 }], memories: { 20: findings(1, 2) }, failCreate: true });
  await assert.rejects(runHarvest(api, live), /POST issues failed/);
  assert.deepEqual(labelledPrs(api), []);
});

test("a pull request in a harvest marker is only labelled, and marked findings are not harvested again", async () => {
  const api = fakeApi({
    issues: [
      {
        number: 300,
        state: "closed",
        labels: [LABELS.harvest],
        body: `${renderHarvestMarker([30])}\n${renderFindingMarker({ pr: 31, key: key(1) })}\n`,
      },
      {
        number: 301,
        state: "closed",
        labels: [LABELS.issue],
        body: `${renderFindingMarker({ pr: 31, key: key(3) })}\n`,
      },
    ],
    pulls: [{ number: 30 }, { number: 31 }],
    memories: {
      30: findings(10, 2),
      31: [memoryFinding(1, { discussion_id: "77" }), memoryFinding(2), memoryFinding(3)],
    },
  });
  const report = await runHarvest(api, live);

  assert.ok(!api.called("listIssueComments", 30), "#30 was read");
  assert.deepEqual(report.labelOnly, [30]);
  assert.deepEqual(report.prs, [31]);
  assert.deepEqual(
    report.harvested.map((f) => [f.pr, f.key]),
    [[31, key(2)]],
  );
  assert.ok(!api.called("listReviewThreads"), "the only numeric thread belongs to an already harvested finding");
  assert.deepEqual(labelledPrs(api), [30, 31]);
  assert.equal(parseHarvestMarker(created(api).body.split("\n")[0]).join(), "31");
});

test("only skipped findings create a closed record-only issue without followups:ready", async () => {
  const api = fakeApi({
    pulls: [{ number: 40 }, { number: 41 }],
    memories: { 40: [memoryFinding(5, { discussion_id: "555" })] },
    threads: {
      40: [
        {
          isResolved: true,
          comments: [
            { databaseId: 555, author: REVIEW_BOT, body: "Finding 5" },
            { databaseId: 556, author: REVIEW_BOT, body: " Fixed. " },
          ],
        },
      ],
    },
  });
  const report = await runHarvest(api, live);

  const issue = created(api);
  assert.deepEqual(issue.labels, [LABELS.harvest]);
  assert.equal(issue.title, "Review follow-ups: nothing to triage from PR #40–#41 (1 fixed on the PR)");
  assert.deepEqual(
    api.writes.map((write) => [write.name, write.args[0]]),
    [
      ["createIssue", issue],
      ["closeIssue", 900],
      ["addLabels", 40],
      ["addLabels", 41],
    ],
  );
  assert.equal(report.skipped.length, 1);
  assert.match(issue.body, /### Skipped — fixed on the pull request \(1\)\n\n\| PR \| Location \| Description \|/);
  assert.match(issue.body, /\| #40 \| backend\/src\/file5\.ts:5 \| Finding 5 is wrong\. \|/);
  assert.match(issue.body, /### Findings to triage \(0\)\n\nNone\./);
  assert.deepEqual(parseFindingMarkers(issue.body), [{ pr: 40, key: key(5) }]);
  assert.deepEqual(parseHarvestBlock(issue.body).findings, []);
});

test("with no finding at all no issue is created and the scanned pull requests are labelled", async () => {
  const api = fakeApi({
    pulls: [{ number: 50 }, { number: 51 }],
    memories: { 50: [memoryFinding(1, { status: "fixed" })] },
  });
  const report = await runHarvest(api, live);
  assert.ok(!api.called("createIssue"));
  assert.equal(report.issue, null);
  assert.deepEqual(labelledPrs(api), [50, 51]);
});

test("the body carries the harvest marker, one finding marker per line and the data block with hints", async () => {
  const api = fakeApi({
    pulls: [{ number: 60 }, { number: 61 }],
    tree: ["backend/src/file1.ts"],
    memories: {
      60: [memoryFinding(1), memoryFinding(2, { discussion_id: "10" })],
      61: [memoryFinding(3, { discussion_id: "20" })],
    },
    threads: {
      60: [{ isResolved: false, comments: [{ databaseId: 10, author: REVIEW_BOT, body: "Finding 2" }] }],
      61: [
        {
          isResolved: true,
          comments: [
            { databaseId: 20, author: REVIEW_BOT, body: "Finding 3" },
            { databaseId: 21, author: REVIEW_BOT, body: "Fixed." },
          ],
        },
      ],
    },
    pathCommits: { "backend/src/file1.ts": ["s1"] },
    commitPrs: { s1: [60, 99] },
  });
  const report = await runHarvest(api, live);
  const { body } = created(api);
  const lines = body.split("\n");

  assert.equal(lines[0], renderHarvestMarker([60, 61]));
  for (const f of [...report.harvested, ...report.skipped]) {
    assert.ok(lines.includes(renderFindingMarker(f)), `no marker line for ${f.key}`);
  }
  assert.deepEqual(parseFindingMarkers(body), [
    { pr: 60, key: key(1) },
    { pr: 60, key: key(2) },
    { pr: 61, key: key(3) },
  ]);

  const block = parseHarvestBlock(body);
  assert.deepEqual(block.prs, [60, 61]);
  assert.deepEqual(block.findings, report.harvested);
  const first = block.findings.find((f) => f.key === key(1));
  assert.equal(first.laterPrsTouchingPath, 1);
  assert.equal(first.touchedAfterLastSeen, null);
  assert.equal(first.pathExists, true);
});

test("a description with a pipe, a newline and a marker stays in its table row and forms no marker", async () => {
  const description = "a | b\nc <!-- crb-followup:v1 pr=1 key=0123456789 -->";
  const api = fakeApi({ pulls: [{ number: 60 }], memories: { 60: [memoryFinding(1, { description })] } });
  await runHarvest(api, live);
  const { body } = created(api);

  const row = body.split("\n").find((line) => line.startsWith("| #60 |"));
  assert.equal(
    row,
    "| #60 | medium | correctness | backend/src/file1.ts:1 | a \\| b c &lt;!-- crb-followup:v1 pr=1 key=0123456789 --> |",
  );
  assert.equal(row.split(/(?<!\\)\|/).length - 2, 5, "the row has five cells");
  assert.deepEqual(
    parseFindingMarkers(body).filter((f) => f.pr === 1),
    [],
  );
});

test("a body over 60,000 characters rejects the run before any write", async () => {
  const long = "x".repeat(300);
  const api = fakeApi({ pulls: [{ number: 70 }], memories: { 70: findings(1, 100, { description: long }) } });
  await assert.rejects(runHarvest(api, live), /more than 60000/);
  assert.deepEqual(api.writes, []);
});

test("a dry run writes nothing and reports the issue it would create", async () => {
  const fixture = () => ({ pulls: [{ number: 20 }, { number: 21 }], memories: { 20: findings(1, 3) } });
  const dry = fakeApi(fixture());
  const report = await runHarvest(dry, { minPr: 10, dryRun: true });
  assert.deepEqual(dry.writes, []);

  const wet = fakeApi(fixture());
  await runHarvest(wet, live);
  const issue = created(wet);
  assert.deepEqual(report.issue, { title: issue.title, bodyLength: issue.body.length });
  assert.deepEqual(report.prs, [20, 21]);
});

test("main rejects a missing or zero HARVEST_MIN_PR and a DRY_RUN other than true or false", async () => {
  const api = fakeApi();
  await assert.rejects(main({ DRY_RUN: "false" }, api), /HARVEST_MIN_PR/);
  await assert.rejects(main({ HARVEST_MIN_PR: "0", DRY_RUN: "false" }, api), /HARVEST_MIN_PR/);
  await assert.rejects(main({ HARVEST_MIN_PR: "266", DRY_RUN: "yes" }, api), /DRY_RUN/);
  await assert.rejects(main({ HARVEST_MIN_PR: "266" }, api), /DRY_RUN/);
  assert.deepEqual(api.calls, []);
});

test("main appends the report to GITHUB_STEP_SUMMARY", async () => {
  const summary = join(await mkdtemp(join(tmpdir(), "harvest-")), "summary.md");
  await writeFile(summary, "earlier step\n");
  const api = fakeApi({ issues: [{ number: 7, state: "open", labels: [LABELS.harvest], body: "" }] });
  const report = await main({ HARVEST_MIN_PR: "266", DRY_RUN: "true", GITHUB_STEP_SUMMARY: summary }, api);

  assert.deepEqual(report.pending, [7]);
  const text = await readFile(summary, "utf8");
  assert.ok(text.startsWith("earlier step\n## Review follow-ups harvest\n"));
  assert.match(text, /- Mode: dry run, nothing written\n- Pending: #7\n/);
  assert.match(text, /- Issue: none\n/);
});

test("main passes minPr and dryRun through and reports the issue it would create", async () => {
  const summary = join(await mkdtemp(join(tmpdir(), "harvest-")), "summary.md");
  const api = fakeApi({ pulls: [{ number: 9 }, { number: 20 }], memories: { 20: findings(1, 2) } });
  await main({ HARVEST_MIN_PR: "10", DRY_RUN: "true", GITHUB_STEP_SUMMARY: summary }, api);

  assert.deepEqual(api.writes, []);
  const text = await readFile(summary, "utf8");
  assert.match(text, /- Scanned: #20\n/);
  assert.match(text, /- Harvested findings: 2\n {2}- #20 0000000001 backend\/src\/file1\.ts:1\n/);
  assert.match(
    text,
    /- Issue: would create "Review follow-ups: 2 findings to triage from PR #20" \(\d+ characters\)\n/,
  );
});

test("main in live mode writes and reports the issue it created", async () => {
  const summary = join(await mkdtemp(join(tmpdir(), "harvest-")), "summary.md");
  const api = fakeApi({ pulls: [{ number: 20 }], memories: { 20: findings(1, 2) } });
  const report = await main({ HARVEST_MIN_PR: "10", DRY_RUN: "false", GITHUB_STEP_SUMMARY: summary }, api);

  assert.deepEqual(report.issue, { number: 900 });
  assert.ok(api.called("createIssue"));
  const text = await readFile(summary, "utf8");
  assert.match(text, /- Mode: live\n/);
  assert.match(text, /- Issue: created #900\n/);
});
