import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseInputFile, renderInputFile } from "./input-file.mjs";
import { renderFindingMarker, renderResultMarker } from "./markers.mjs";
import { main, prepareInput } from "./prepare.mjs";
import { renderHarvestBlock } from "./records.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "prepare.mjs");
const HARVEST = 900;
const KEY_A = "aaaaaaaaaa";
const KEY_B = "bbbbbbbbbb";
const KEY_C = "cccccccccc";

function finding(overrides = {}) {
  return {
    pr: 10,
    key: KEY_A,
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
    ...overrides,
  };
}

function harvestIssue(findings, overrides = {}) {
  const prs = [...new Set(findings.map((f) => f.pr))].sort((a, b) => a - b);
  return {
    number: HARVEST,
    id: 1,
    state: "open",
    title: "Harvest",
    body: `Harvest intro\n\n${renderHarvestBlock({ prs: prs.length > 0 ? prs : [10], findings })}`,
    labels: ["followups:harvest"],
    ...overrides,
  };
}

function issue(number, labels, body, title = `Issue ${number}`) {
  return { number, id: number, state: "open", title, body, labels };
}

function comment(author, body, createdAt = "2026-09-01T00:00:00Z") {
  return { id: 1, author, createdAt, body };
}

function thread(comments) {
  return { isResolved: false, comments };
}

/**
 * A fake api over `harvest`, the issues per label (`byLabel`), comments per issue or
 * pull request number and review threads per pull request. It records every call.
 */
function fakeApi({ harvest, byLabel = {}, comments = {}, threads = {} }) {
  const calls = [];
  return {
    calls,
    async getIssue(number) {
      calls.push(["getIssue", number]);
      assert.equal(number, harvest.number);
      return harvest;
    },
    async listIssuesWithLabel(label, state) {
      calls.push(["listIssuesWithLabel", label, state]);
      return byLabel[`${label}/${state}`] ?? [];
    },
    async listIssueComments(number) {
      calls.push(["listIssueComments", number]);
      return comments[number] ?? [];
    },
    async listReviewThreads(pr) {
      calls.push(["listReviewThreads", pr]);
      return threads[pr] ?? [];
    },
  };
}

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "prepare-test-"));
}

// 1. Harvest issue checks.

test("a closed harvest issue is rejected", async () => {
  const api = fakeApi({ harvest: harvestIssue([finding()], { state: "closed" }) });
  await assert.rejects(prepareInput(api, HARVEST), /is closed, not open/);
});

test("an open issue without followups:harvest is rejected", async () => {
  const api = fakeApi({ harvest: harvestIssue([finding()], { labels: ["followups:ready"] }) });
  await assert.rejects(prepareInput(api, HARVEST), /not labelled followups:harvest/);
});

test("a harvest issue without a data block is rejected", async () => {
  const api = fakeApi({ harvest: harvestIssue([finding()], { body: "no block here" }) });
  await assert.rejects(prepareInput(api, HARVEST), /no <!-- crb-followup-data:v1 --> marker/);
});

// 2. Terminal ledger.

test("findings already published are dropped; a result comment by another author does not count", async () => {
  const findings = [
    finding({ key: KEY_A }),
    finding({ key: KEY_B }),
    finding({ key: KEY_C }),
    finding({ pr: 11, key: KEY_A }),
    finding({ pr: 12, key: KEY_A }),
  ];
  const result = (author, pr, key) =>
    comment(author, `Triage result\n${renderResultMarker(HARVEST)}\n${renderFindingMarker({ pr, key })}\n`);
  const api = fakeApi({
    harvest: harvestIssue(findings),
    byLabel: {
      "followups:issue/all": [
        { ...issue(1, ["followups:issue"], `x\n${renderFindingMarker({ pr: 10, key: KEY_A })}\n`), state: "open" },
        { ...issue(2, ["followups:issue"], `x\n${renderFindingMarker({ pr: 10, key: KEY_B })}\n`), state: "closed" },
      ],
    },
    comments: {
      [HARVEST]: [result("bb-agent-relay[bot]", 11, KEY_A), result("someone", 12, KEY_A)],
    },
  });
  const input = await prepareInput(api, HARVEST);
  assert.deepEqual(
    input.findings.map((f) => `${f.pr}:${f.key}`),
    [`10:${KEY_C}`, `12:${KEY_A}`],
  );
  assert.ok(api.calls.some((call) => call[0] === "listIssuesWithLabel" && call[1] === "followups:issue" && call[2] === "all"));
});

// 3–5. Thread text.

test("a trusted root in the bot's format is split into fullText and suggestedFix", async () => {
  const findings = [finding({ key: KEY_A, discussionId: "101" }), finding({ key: KEY_B, discussionId: "102" })];
  const withFix =
    "**correctness | MEDIUM**\n\nThe full description\nover two lines.\n\n**Suggested fix:**\n```\nconst a = 1;\n```\nstill fix\n```";
  const withoutFix = "**io | HIGH**\r\n\r\nOnly a description.";
  const api = fakeApi({
    harvest: harvestIssue(findings),
    threads: {
      10: [
        thread([{ databaseId: 101, author: "github-actions[bot]", body: withFix }]),
        thread([{ databaseId: 102, author: "bb-agent-relay[bot]", body: withoutFix }]),
      ],
    },
  });
  const [first, second] = (await prepareInput(api, HARVEST)).findings;
  assert.equal(first.fullText, "The full description\nover two lines.");
  assert.equal(first.suggestedFix, "const a = 1;\n```\nstill fix");
  assert.deepEqual(first.threadReplies, []);
  assert.equal(second.fullText, "Only a description.");
  assert.equal(second.suggestedFix, null);
});

test("a trusted root whose Suggested fix marker is not followed by a fenced block gets a null suggestedFix", async () => {
  const findings = [finding({ key: KEY_A, discussionId: "101" }), finding({ key: KEY_B, discussionId: "102" })];
  const markerAtEnd = "**correctness | MEDIUM**\n\nText before the marker.\n\n**Suggested fix:**";
  const unclosedFence = "**io | HIGH**\n\nAnother description.\n\n**Suggested fix:**\n```\nconst a = 1;";
  const api = fakeApi({
    harvest: harvestIssue(findings),
    threads: {
      10: [
        thread([{ databaseId: 101, author: "github-actions[bot]", body: markerAtEnd }]),
        thread([{ databaseId: 102, author: "bb-agent-relay[bot]", body: unclosedFence }]),
      ],
    },
  });
  const [first, second] = (await prepareInput(api, HARVEST)).findings;
  assert.equal(first.fullText, "Text before the marker.");
  assert.equal(first.suggestedFix, null);
  assert.equal(second.fullText, "Another description.");
  assert.equal(second.suggestedFix, null);
});

test("a root by a human, or without the header line, is kept whole; replies keep their order", async () => {
  const findings = [finding({ key: KEY_A, discussionId: "101" }), finding({ key: KEY_B, discussionId: "102" })];
  const human = "**correctness | MEDIUM**\n\nWritten by a person.";
  const noHeader = "Plain text from the bot\n\n**Suggested fix:**\n```\nx\n```";
  const api = fakeApi({
    harvest: harvestIssue(findings),
    threads: {
      10: [
        thread([
          { databaseId: 101, author: "mallory", body: human },
          { databaseId: 201, author: "alice", body: "first reply" },
          { databaseId: 202, author: "github-actions[bot]", body: "second reply" },
        ]),
        thread([{ databaseId: 102, author: "github-actions[bot]", body: noHeader }]),
      ],
    },
  });
  const [first, second] = (await prepareInput(api, HARVEST)).findings;
  assert.equal(first.fullText, human);
  assert.equal(first.suggestedFix, null);
  assert.deepEqual(first.threadReplies, [
    { author: "alice", body: "first reply" },
    { author: "github-actions[bot]", body: "second reply" },
  ]);
  assert.equal(second.fullText, noHeader);
  assert.equal(second.suggestedFix, null);
});

test("no discussion id, or a thread that is gone, gives empty thread fields; threads are fetched once per pull request", async () => {
  const findings = [
    finding({ key: KEY_A, discussionId: "" }),
    finding({ key: KEY_B, discussionId: "555" }),
    finding({ key: KEY_C, discussionId: "556" }),
  ];
  const api = fakeApi({
    harvest: harvestIssue(findings),
    threads: { 10: [thread([]), thread([{ databaseId: 1, author: "github-actions[bot]", body: "other" }])] },
  });
  const input = await prepareInput(api, HARVEST);
  for (const entry of input.findings) {
    assert.equal(entry.fullText, null);
    assert.equal(entry.suggestedFix, null);
    assert.deepEqual(entry.threadReplies, []);
  }
  assert.deepEqual(
    api.calls.filter((call) => call[0] === "listReviewThreads"),
    [["listReviewThreads", 10]],
  );
});

test("findings without a discussion id cause no thread fetch", async () => {
  const api = fakeApi({ harvest: harvestIssue([finding()]) });
  await prepareInput(api, HARVEST);
  assert.equal(api.calls.filter((call) => call[0] === "listReviewThreads").length, 0);
});

// 6. Review summaries.

test("prSummaries takes the newest trusted summary and skips pull requests without one", async () => {
  const findings = [finding({ pr: 10 }), finding({ pr: 11 }), finding({ pr: 12 })];
  const api = fakeApi({
    harvest: harvestIssue(findings),
    comments: {
      10: [
        comment("github-actions[bot]", "## AI Code Review Summary\nold", "2026-09-01T00:00:00Z"),
        comment("bb-agent-relay[bot]", "## AI Code Review Summary\nnew", "2026-09-03T00:00:00Z"),
        comment("mallory", "## AI Code Review Summary\nfake", "2026-09-04T00:00:00Z"),
        comment("github-actions[bot]", "Review memory\n## AI Code Review Summary", "2026-09-05T00:00:00Z"),
      ],
      11: [comment("mallory", "## AI Code Review Summary\nfake")],
    },
  });
  const input = await prepareInput(api, HARVEST);
  assert.deepEqual(input.prSummaries, [{ pr: 10, body: "## AI Code Review Summary\nnew" }]);
});

// 7. Open queued issues.

test("openIssues is deduplicated and carries each issue's Touches section", async () => {
  const both = issue(
    40,
    ["agent:ready", "spec:approved"],
    "## Context\nctx\n\n## Touches\n\n- a.ts\n- b.ts\n\n## Scope\nno\n",
    "Both labels",
  );
  const proposed = issue(30, ["spec:proposed"], "## Task\nno touches here\n", "Proposed");
  const lastSection = issue(50, ["spec:approved"], "## Touches\r\n- c.ts\r\n### Sub\r\n- d.ts", "Last");
  const api = fakeApi({
    harvest: harvestIssue([finding()]),
    byLabel: {
      "agent:ready/open": [both],
      "spec:approved/open": [both, lastSection],
      "spec:proposed/open": [proposed],
    },
  });
  const input = await prepareInput(api, HARVEST);
  assert.deepEqual(input.openIssues, [
    { number: 30, title: "Proposed", labels: ["spec:proposed"], touches: "" },
    { number: 40, title: "Both labels", labels: ["agent:ready", "spec:approved"], touches: "- a.ts\n- b.ts" },
    { number: 50, title: "Last", labels: ["spec:approved"], touches: "- c.ts\n### Sub\n- d.ts" },
  ]);
});

// 8. The file.

test("the returned object is a valid input file in data block order", async () => {
  const findings = [finding({ pr: 11, key: KEY_B }), finding({ pr: 10, key: KEY_A, discussionId: "7" })];
  const api = fakeApi({
    harvest: harvestIssue(findings),
    threads: { 10: [thread([{ databaseId: 7, author: "github-actions[bot]", body: "**a | LOW**\n\ntext" }])] },
    comments: { 11: [comment("github-actions[bot]", "## AI Code Review Summary\nok")] },
  });
  const input = await prepareInput(api, HARVEST);
  assert.equal(input.version, 1);
  assert.equal(input.harvestIssue, HARVEST);
  assert.deepEqual(
    input.findings.map((f) => f.pr),
    [11, 10],
  );
  assert.deepEqual(parseInputFile(renderInputFile(input)), input);
});

test("main writes <dir>/input.json and reports the counts", async (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, "nested", "triage");
  const findings = [finding({ key: KEY_A }), finding({ key: KEY_B })];
  const api = fakeApi({
    harvest: harvestIssue(findings),
    byLabel: {
      "followups:issue/all": [issue(1, ["followups:issue"], renderFindingMarker({ pr: 10, key: KEY_A }))],
    },
  });
  const logs = [];
  t.mock.method(console, "log", (line) => logs.push(line));
  await main(["--harvest-issue", String(HARVEST), "--out", out], api);
  const written = parseInputFile(readFileSync(path.join(out, "input.json"), "utf8"));
  assert.deepEqual(written, await prepareInput(api, HARVEST));
  assert.equal(written.findings.length, 1);
  assert.match(logs.join("\n"), /1 finding\(s\) pending, 1 already published/);
});

test("main writes the file when nothing is pending", async (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const api = fakeApi({
    harvest: harvestIssue([finding()]),
    byLabel: { "followups:issue/all": [issue(1, ["followups:issue"], renderFindingMarker({ pr: 10, key: KEY_A }))] },
  });
  t.mock.method(console, "log", () => {});
  await main(["--out", dir, "--harvest-issue", String(HARVEST)], api);
  const written = parseInputFile(readFileSync(path.join(dir, "input.json"), "utf8"));
  assert.deepEqual(written.findings, []);
  assert.deepEqual(written.prSummaries, []);
});

// 9. Failures.

test("main rejects bad arguments without writing a file", async (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const api = fakeApi({ harvest: harvestIssue([finding()]) });
  for (const argv of [
    ["--out", dir],
    ["--harvest-issue", "--out", dir],
    ["--harvest-issue", "abc", "--out", dir],
    ["--harvest-issue", "0", "--out", dir],
    ["--harvest-issue", "-3", "--out", dir],
    ["--harvest-issue", "1.5", "--out", dir],
    ["--harvest-issue", "900"],
    ["--harvest-issue", "900", "--out", dir, "--extra", "x"],
  ]) {
    await assert.rejects(main(argv, api), undefined, JSON.stringify(argv));
  }
  assert.equal(api.calls.length, 0);
  assert.equal(existsSync(path.join(dir, "input.json")), false);
});

test("main rejects without writing a file when the api throws", async (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, "out");
  const api = fakeApi({ harvest: harvestIssue([finding({ discussionId: "1" })]) });
  api.listReviewThreads = async () => {
    throw new Error("graphql down");
  };
  await assert.rejects(main(["--harvest-issue", String(HARVEST), "--out", out], api), /graphql down/);
  assert.equal(existsSync(out), false);
});

test("the CLI exits non-zero without writing a file on a missing argument or a failing client", (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GITHUB_TOKEN: "", GITHUB_REPOSITORY: "owner/repo" };
  const missing = spawnSync(process.execPath, [SCRIPT, "--out", dir], { env, encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  const noToken = spawnSync(process.execPath, [SCRIPT, "--harvest-issue", "5", "--out", dir], { env, encoding: "utf8" });
  assert.notEqual(noToken.status, 0);
  assert.match(noToken.stderr, /GITHUB_TOKEN is required/);
  assert.equal(existsSync(path.join(dir, "input.json")), false);
});
