import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeLedger, renderFindingMarker } from "./markers.mjs";
import { validateFindingRecord } from "./records.mjs";
import { HARVEST_CAP, candidatePullRequests, classifyPullRequest, createHarvestPlan, pendingWork } from "./select.mjs";

const PR = 301;
const SHA_A = "a".repeat(40);
const SHA_B = "0123456789abcdef0123456789abcdef01234567";
const PATH = "backend/packages/data/src/store.ts";
const EMPTY_LEDGER = computeLedger([]);

function memoryFinding(overrides = {}) {
  return {
    key: "0123456789",
    path: PATH,
    line: 42,
    severity: "medium",
    category: "error handling",
    description: "A catch maps every failure onto a validation error.",
    anchor: "abcdef0123",
    status: "open",
    discussionId: "1001",
    firstSeenSha: SHA_A,
    lastSeenSha: SHA_B,
    ...overrides,
  };
}

function thread(isResolved, replies, rootId = 1001) {
  return {
    isResolved,
    comments: [
      { databaseId: rootId, author: "github-actions[bot]", body: "**medium** error handling" },
      ...replies.map(([author, body], i) => ({ databaseId: rootId + i + 1, author, body })),
    ],
  };
}

function classify({ findings = [memoryFinding()], threads = [], treePaths = new Set([PATH]), ledger = EMPTY_LEDGER }) {
  return classifyPullRequest({ pr: PR, memoryFindings: findings, threads, treePaths, ledger });
}

function findings(count, pr) {
  return Array.from({ length: count }, (_, i) => ({ pr, key: i.toString(16).padStart(10, "0") }));
}

describe("pendingWork", () => {
  it("returns harvest issues and proposed follow-up issues, ascending", () => {
    const issues = [
      { number: 9, labels: ["followups:issue", "spec:proposed"] },
      { number: 3, labels: ["followups:harvest"] },
      { number: 4, labels: ["followups:issue"] },
      { number: 5, labels: ["spec:proposed"] },
      { number: 6, labels: ["followups:issue", "spec:approved"] },
      { number: 7, labels: [] },
    ];
    assert.deepEqual(pendingWork(issues), [3, 9]);
  });

  it("returns an empty array when nothing holds the harvest back", () => {
    assert.deepEqual(pendingWork([{ number: 4, labels: ["followups:issue"] }]), []);
    assert.deepEqual(pendingWork([]), []);
  });
});

describe("candidatePullRequests", () => {
  it("keeps pull requests at or above minPr without followups:harvested, ascending", () => {
    const pulls = [
      { number: 320, mergedAt: "2026-09-20T00:00:00Z", labels: [] },
      { number: 299, mergedAt: "2026-09-19T00:00:00Z", labels: [] },
      { number: 300, mergedAt: "2026-09-19T00:00:00Z", labels: ["area:web"] },
      { number: 310, mergedAt: "2026-09-19T00:00:00Z", labels: ["followups:harvested"] },
      { number: 305, mergedAt: "2026-09-21T00:00:00Z", labels: [] },
    ];
    assert.deepEqual(
      candidatePullRequests(pulls, { minPr: 300 }).map(({ number }) => number),
      [300, 305, 320],
    );
  });
});

describe("classifyPullRequest", () => {
  it("returns two empty lists without a memory", () => {
    assert.deepEqual(
      classifyPullRequest({
        pr: PR,
        memoryFindings: null,
        threads: [],
        treePaths: new Set(),
        ledger: EMPTY_LEDGER,
      }),
      { harvest: [], skipped: [] },
    );
  });

  it("ignores findings that are not open", () => {
    const result = classify({
      findings: ["resolved", "wontfix", "fixed"].map((status, i) => memoryFinding({ status, key: `000000000${i}` })),
    });
    assert.deepEqual(result, { harvest: [], skipped: [] });
  });

  it("ignores an open finding already in the ledger's harvested set", () => {
    const ledger = computeLedger([
      {
        number: 50,
        labels: ["followups:harvest"],
        body: renderFindingMarker({ pr: PR, key: "0123456789" }),
        comments: [],
      },
    ]);
    const result = classify({
      findings: [memoryFinding(), memoryFinding({ key: "fedcba9876" })],
      ledger,
    });
    assert.deepEqual(
      result.harvest.map(({ key }) => key),
      ["fedcba9876"],
    );
    assert.deepEqual(result.skipped, []);
  });

  it("skips a resolved thread with a trusted bot's Fixed. reply", () => {
    const result = classify({ threads: [thread(true, [["github-actions[bot]", "Fixed."]])] });
    assert.deepEqual(result.harvest, []);
    assert.deepEqual(result.skipped, [
      {
        pr: PR,
        key: "0123456789",
        path: PATH,
        line: 42,
        category: "error handling",
        description: "A catch maps every failure onto a validation error.",
      },
    ]);
  });

  it("skips a resolved thread with a whitespace-padded Fixed. from bb-agent-relay[bot]", () => {
    const result = classify({
      threads: [
        thread(true, [
          ["dvdtrsnk", "Pushed a fix"],
          ["bb-agent-relay[bot]", " Fixed. "],
        ]),
      ],
    });
    assert.equal(result.harvest.length, 0);
    assert.equal(result.skipped.length, 1);
  });

  for (const [name, replies] of [
    ["no reply", []],
    ["only a human's Fixed.", [["dvdtrsnk", "Fixed."]]],
    ["a trusted bot's Fixed. Thanks", [["github-actions[bot]", "Fixed. Thanks"]]],
    ["a will do in a follow-up reply", [["github-actions[bot]", "will do in a follow-up"]]],
  ]) {
    it(`harvests a resolved thread with ${name}`, () => {
      const result = classify({ threads: [thread(true, replies)] });
      assert.deepEqual(result.skipped, []);
      assert.equal(result.harvest.length, 1);
      assert.equal(result.harvest[0].threadResolved, true);
      assert.equal(result.harvest[0].discussionId, "1001");
    });
  }

  it("does not treat the root comment as a reply", () => {
    const root = thread(true, []);
    root.comments[0].body = "Fixed.";
    const result = classify({ threads: [root] });
    assert.equal(result.harvest.length, 1);
    assert.deepEqual(result.harvest[0].replies, []);
  });

  it("harvests an unresolved thread with a trusted Fixed. reply", () => {
    const result = classify({ threads: [thread(false, [["github-actions[bot]", "Fixed."]])] });
    assert.deepEqual(result.skipped, []);
    assert.equal(result.harvest[0].threadResolved, false);
    assert.deepEqual(result.harvest[0].replies, [{ author: "github-actions[bot]", excerpt: "Fixed." }]);
  });

  it("keeps the last three of five replies, each cut to 200 characters", () => {
    const replies = [1, 2, 3, 4, 5].map((n) => [`user${n}`, `${n}`.repeat(250)]);
    const result = classify({ threads: [thread(true, replies)] });
    assert.deepEqual(result.harvest[0].replies, [
      { author: "user3", excerpt: "3".repeat(200) },
      { author: "user4", excerpt: "4".repeat(200) },
      { author: "user5", excerpt: "5".repeat(200) },
    ]);
  });

  it("cuts an excerpt at 200 code points, not UTF-16 units", () => {
    const result = classify({ threads: [thread(false, [["dvdtrsnk", "😀".repeat(201)]])] });
    assert.equal(result.harvest[0].replies[0].excerpt, "😀".repeat(200));
  });

  it("matches the thread by its root comment's databaseId", () => {
    const result = classify({
      threads: [thread(true, [["github-actions[bot]", "Fixed."]], 999), thread(false, [["dvdtrsnk", "later"]])],
    });
    assert.equal(result.harvest.length, 1);
    assert.equal(result.harvest[0].threadResolved, false);
    assert.deepEqual(result.harvest[0].replies, [{ author: "dvdtrsnk", excerpt: "later" }]);
  });

  for (const [name, discussionId, expectedId] of [
    ["a non-numeric discussionId", "issue:123", ""],
    ["an empty discussionId", "", ""],
    ["a thread that is not found", "5555", "5555"],
  ]) {
    it(`harvests ${name} without thread data`, () => {
      const result = classify({
        findings: [memoryFinding({ discussionId })],
        threads: [thread(true, [["github-actions[bot]", "Fixed."]], 123)],
      });
      assert.deepEqual(result.skipped, []);
      assert.equal(result.harvest[0].discussionId, expectedId);
      assert.equal(result.harvest[0].threadResolved, false);
      assert.deepEqual(result.harvest[0].replies, []);
    });
  }

  it("harvests a finding whose path is absent from the tree with pathExists false", () => {
    const result = classify({ treePaths: new Set(["web/src/other.ts"]) });
    assert.equal(result.harvest.length, 1);
    assert.equal(result.harvest[0].pathExists, false);
    assert.equal(classify({}).harvest[0].pathExists, true);
  });

  it("sets descriptionTruncated exactly when the description ends with …", () => {
    const [truncated, midEllipsis, plain] = classify({
      findings: [
        memoryFinding({ key: "0000000001", description: "Cut short…" }),
        memoryFinding({ key: "0000000002", description: "An … in the middle." }),
        memoryFinding({ key: "0000000003", description: "Whole." }),
      ],
    }).harvest;
    assert.equal(truncated.descriptionTruncated, true);
    assert.equal(midEllipsis.descriptionTruncated, false);
    assert.equal(plain.descriptionTruncated, false);
  });

  it("keeps the memory's order in both lists", () => {
    const result = classify({
      findings: [
        memoryFinding({ key: "000000000a", discussionId: "" }),
        memoryFinding({ key: "000000000b", discussionId: "1001" }),
        memoryFinding({ key: "000000000c", discussionId: "" }),
        memoryFinding({ key: "000000000d", discussionId: "2001" }),
      ],
      threads: [
        thread(true, [["github-actions[bot]", "Fixed."]], 1001),
        thread(true, [["github-actions[bot]", "Fixed."]], 2001),
      ],
    });
    assert.deepEqual(
      result.harvest.map(({ key }) => key),
      ["000000000a", "000000000c"],
    );
    assert.deepEqual(
      result.skipped.map(({ key }) => key),
      ["000000000b", "000000000d"],
    );
  });

  it("returns harvested entries that are valid finding records once the hints are added", () => {
    const result = classify({
      findings: [
        memoryFinding({ key: "0000000001", description: `${"x".repeat(299)}…`, anchor: "" }),
        memoryFinding({ key: "0000000002", discussionId: "issue:123", firstSeenSha: "", lastSeenSha: "" }),
        memoryFinding({ key: "0000000003", severity: "critical", path: "gone.ts" }),
      ],
      threads: [
        thread(
          true,
          [1, 2, 3, 4].map((n) => [`user${n}`, "y".repeat(300)]),
        ),
      ],
    });
    assert.equal(result.harvest.length, 3);
    for (const entry of result.harvest) {
      validateFindingRecord({ ...entry, touchedAfterLastSeen: null, laterPrsTouchingPath: 0 });
    }
  });
});

describe("createHarvestPlan", () => {
  it("defaults the cap to 30", () => {
    assert.equal(HARVEST_CAP, 30);
    const plan = createHarvestPlan();
    assert.equal(plan.offer({ pr: 1, alreadyRecorded: false, harvest: findings(20, 1), skipped: [] }), "take");
    assert.equal(plan.offer({ pr: 2, alreadyRecorded: false, harvest: findings(10, 2), skipped: [] }), "take");
    assert.equal(plan.offer({ pr: 3, alreadyRecorded: false, harvest: findings(1, 3), skipped: [] }), "stop");
  });

  it("takes pull requests in order and stops before the one that would exceed the cap", () => {
    const plan = createHarvestPlan({ cap: 30 });
    assert.equal(plan.offer({ pr: 10, alreadyRecorded: false, harvest: findings(12, 10), skipped: [] }), "take");
    assert.equal(plan.offer({ pr: 11, alreadyRecorded: false, harvest: findings(15, 11), skipped: [] }), "take");
    assert.equal(plan.offer({ pr: 12, alreadyRecorded: false, harvest: findings(5, 12), skipped: [] }), "stop");
    const result = plan.plan();
    assert.deepEqual(result.prs, [10, 11]);
    assert.equal(result.harvest.length, 27);
    assert.deepEqual(result.harvest, [...findings(12, 10), ...findings(15, 11)]);
    assert.equal(result.stoppedAt, 12);
  });

  it("always takes the first pull request with harvested findings", () => {
    const plan = createHarvestPlan({ cap: 30 });
    assert.equal(plan.offer({ pr: 10, alreadyRecorded: false, harvest: [], skipped: [] }), "take");
    assert.equal(plan.offer({ pr: 11, alreadyRecorded: false, harvest: findings(31, 11), skipped: [] }), "take");
    assert.equal(plan.offer({ pr: 12, alreadyRecorded: false, harvest: [], skipped: [] }), "take");
    assert.equal(plan.offer({ pr: 13, alreadyRecorded: false, harvest: findings(1, 13), skipped: [] }), "stop");
    const result = plan.plan();
    assert.deepEqual(result.prs, [10, 11, 12]);
    assert.equal(result.harvest.length, 31);
    assert.equal(result.stoppedAt, 13);
  });

  it("refuses everything after a stop without changing the plan", () => {
    const plan = createHarvestPlan({ cap: 30 });
    plan.offer({ pr: 10, alreadyRecorded: false, harvest: findings(12, 10), skipped: [] });
    plan.offer({ pr: 11, alreadyRecorded: false, harvest: findings(15, 11), skipped: [] });
    assert.equal(plan.offer({ pr: 12, alreadyRecorded: false, harvest: findings(5, 12), skipped: [] }), "stop");
    const before = plan.plan();
    assert.equal(plan.offer({ pr: 13, alreadyRecorded: false, harvest: [], skipped: findings(1, 13) }), "stop");
    assert.equal(plan.offer({ pr: 14, alreadyRecorded: true, harvest: [], skipped: [] }), "stop");
    assert.deepEqual(plan.plan(), before);
  });

  it("takes pull requests with only skipped findings or nothing, without counting them", () => {
    const plan = createHarvestPlan({ cap: 3 });
    assert.equal(plan.offer({ pr: 10, alreadyRecorded: false, harvest: findings(2, 10), skipped: [] }), "take");
    assert.equal(plan.offer({ pr: 11, alreadyRecorded: false, harvest: [], skipped: findings(5, 11) }), "take");
    assert.equal(plan.offer({ pr: 12, alreadyRecorded: false, harvest: [], skipped: [] }), "take");
    assert.equal(plan.offer({ pr: 13, alreadyRecorded: false, harvest: findings(1, 13), skipped: [] }), "take");
    const result = plan.plan();
    assert.deepEqual(result.prs, [10, 11, 12, 13]);
    assert.equal(result.harvest.length, 3);
    assert.deepEqual(result.skipped, findings(5, 11));
    assert.equal(result.stoppedAt, null);
  });

  it("records an alreadyRecorded pull request as label-only and ignores its findings", () => {
    const plan = createHarvestPlan({ cap: 30 });
    assert.equal(
      plan.offer({ pr: 10, alreadyRecorded: true, harvest: findings(40, 10), skipped: findings(2, 10) }),
      "take",
    );
    assert.equal(plan.offer({ pr: 11, alreadyRecorded: false, harvest: findings(3, 11), skipped: [] }), "take");
    assert.deepEqual(plan.plan(), {
      prs: [11],
      labelOnly: [10],
      harvest: findings(3, 11),
      skipped: [],
      stoppedAt: null,
    });
  });

  it("returns an empty plan when nothing was offered", () => {
    assert.deepEqual(createHarvestPlan().plan(), {
      prs: [],
      labelOnly: [],
      harvest: [],
      skipped: [],
      stoppedAt: null,
    });
  });
});
