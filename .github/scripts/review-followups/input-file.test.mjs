import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseInputFile, renderInputFile } from "./input-file.mjs";

const SHA_A = "a".repeat(40);

function entry(overrides = {}) {
  return {
    pr: 301,
    key: "0123456789",
    severity: "medium",
    category: "error handling",
    path: "backend/packages/data/src/store.ts",
    line: 42,
    anchor: "abcdef0123",
    description: "A catch maps every failure onto a validation error.",
    descriptionTruncated: false,
    discussionId: "2345678901",
    threadResolved: false,
    replies: [{ author: "dvdtrsnk", excerpt: "Will fix in a follow-up." }],
    pathExists: true,
    touchedAfterLastSeen: null,
    laterPrsTouchingPath: 0,
    firstSeenSha: SHA_A,
    lastSeenSha: SHA_A,
    fullText: "A catch maps every failure onto a validation error, hiding the real cause.",
    suggestedFix: "Rethrow errors that are not ValidationError.",
    threadReplies: [{ author: "dvdtrsnk", body: "Will fix in a follow-up." }],
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    version: 1,
    harvestIssue: 612,
    findings: [entry(), entry({ pr: 305, key: "fedcba9876", fullText: null, suggestedFix: null, threadReplies: [] })],
    prSummaries: [
      { pr: 301, body: "One medium finding." },
      { pr: 305, body: "" },
    ],
    openIssues: [
      { number: 580, title: "Harden the store", labels: ["agent:ready"], touches: "- backend/x.ts" },
      { number: 581, title: "", labels: [], touches: "" },
    ],
    ...overrides,
  };
}

function withoutField(value, field) {
  const copy = { ...value };
  delete copy[field];
  return copy;
}

/** Each invalid input, with the pattern its error message must match. */
const INVALID = [
  ["a non-object file", [], /must hold a JSON object/],
  ["a missing harvestIssue", withoutField(input(), "harvestIssue"), /"harvestIssue" is missing/],
  ["a missing version", withoutField(input(), "version"), /"version" is missing/],
  ["version 2", input({ version: 2 }), /"version" must be 1/],
  ["a harvestIssue of 0", input({ harvestIssue: 0 }), /"harvestIssue" must be a positive integer/],
  ["an extra top-level field", input({ extra: true }), /unexpected field "extra"/],
  ["findings that is not an array", input({ findings: {} }), /"findings" must be an array/],
  ["an entry that is not an object", input({ findings: [null] }), /"findings\[0\]" must be an object/],
  [
    "an entry without threadReplies",
    input({ findings: [withoutField(entry(), "threadReplies")] }),
    /"findings\[0\]\.threadReplies" is missing/,
  ],
  [
    "an entry without fullText",
    input({ findings: [withoutField(entry(), "fullText")] }),
    /"findings\[0\]\.fullText" is missing/,
  ],
  ["a fullText that is a number", input({ findings: [entry({ fullText: 7 })] }), /"findings\[0\]\.fullText"/],
  [
    "a suggestedFix that is a boolean",
    input({ findings: [entry({ suggestedFix: false })] }),
    /"findings\[0\]\.suggestedFix"/,
  ],
  [
    "threadReplies that is not an array",
    input({ findings: [entry({ threadReplies: "none" })] }),
    /"findings\[0\]\.threadReplies" must be an array/,
  ],
  [
    "a thread reply with an empty author",
    input({ findings: [entry({ threadReplies: [{ author: "", body: "x" }] })] }),
    /"findings\[0\]\.threadReplies\[0\]\.author"/,
  ],
  [
    "a thread reply with a non-string body",
    input({ findings: [entry({ threadReplies: [{ author: "a", body: null }] })] }),
    /"findings\[0\]\.threadReplies\[0\]\.body"/,
  ],
  [
    "a thread reply with an extra field",
    input({ findings: [entry({ threadReplies: [{ author: "a", body: "b", at: 1 }] })] }),
    /"findings\[0\]\.threadReplies\[0\]" has unexpected field "at"/,
  ],
  [
    "a record part with a nine-character key",
    input({ findings: [entry({ key: "012345678" })] }),
    /"findings\[0\]": finding record field "key"/,
  ],
  [
    "an entry with an extra field",
    input({ findings: [entry({ extra: 1 })] }),
    /"findings\[0\]": finding record has unexpected field "extra"/,
  ],
  [
    "a duplicate (pr, key)",
    input({ findings: [entry(), entry({ fullText: null })] }),
    /"findings\[1\]" repeats pr 301 key 0123456789/,
  ],
  ["prSummaries that is not an array", input({ prSummaries: null }), /"prSummaries" must be an array/],
  ["a prSummary without body", input({ prSummaries: [{ pr: 301 }] }), /"prSummaries\[0\]\.body" is missing/],
  [
    "a prSummary with a non-positive pr",
    input({ prSummaries: [{ pr: -1, body: "" }] }),
    /"prSummaries\[0\]\.pr" must be a positive integer/,
  ],
  [
    "a prSummary with a non-string body",
    input({ prSummaries: [{ pr: 301, body: 3 }] }),
    /"prSummaries\[0\]\.body" must be a string/,
  ],
  [
    "two prSummaries for one pr",
    input({
      prSummaries: [
        { pr: 301, body: "a" },
        { pr: 301, body: "b" },
      ],
    }),
    /"prSummaries\[1\]\.pr" repeats pr 301/,
  ],
  ["openIssues that is not an array", input({ openIssues: "x" }), /"openIssues" must be an array/],
  [
    "an open issue with an extra field",
    input({ openIssues: [{ number: 1, title: "", labels: [], touches: "", state: "open" }] }),
    /"openIssues\[0\]" has unexpected field "state"/,
  ],
  [
    "an open issue with a fractional number",
    input({ openIssues: [{ number: 1.5, title: "", labels: [], touches: "" }] }),
    /"openIssues\[0\]\.number" must be a positive integer/,
  ],
  [
    "an open issue with a non-string title",
    input({ openIssues: [{ number: 1, title: null, labels: [], touches: "" }] }),
    /"openIssues\[0\]\.title" must be a string/,
  ],
  [
    "an open issue with labels that is not an array",
    input({ openIssues: [{ number: 1, title: "", labels: "bug", touches: "" }] }),
    /"openIssues\[0\]\.labels" must be an array/,
  ],
  [
    "an open issue with a non-string label",
    input({ openIssues: [{ number: 1, title: "", labels: ["a", 2], touches: "" }] }),
    /"openIssues\[0\]\.labels\[1\]" must be a string/,
  ],
  [
    "an open issue with a non-string touches",
    input({ openIssues: [{ number: 1, title: "", labels: [], touches: [] }] }),
    /"openIssues\[0\]\.touches" must be a string/,
  ],
  [
    "a duplicate openIssues number",
    input({
      openIssues: [
        { number: 580, title: "a", labels: [], touches: "" },
        { number: 580, title: "b", labels: [], touches: "" },
      ],
    }),
    /"openIssues\[1\]\.number" repeats issue 580/,
  ],
];

describe("renderInputFile", () => {
  it("renders two-space indented JSON ending in a newline", () => {
    const text = renderInputFile(input());
    assert.ok(text.endsWith("}\n"));
    assert.equal(text, `${JSON.stringify(input(), null, 2)}\n`);
    assert.match(text, /^\{\n {2}"version": 1,\n {2}"harvestIssue": 612,\n/);
  });

  it("renders a file with empty lists", () => {
    const empty = input({ findings: [], prSummaries: [], openIssues: [] });
    assert.deepEqual(parseInputFile(renderInputFile(empty)), empty);
  });

  for (const [name, value, pattern] of INVALID) {
    it(`throws for ${name}`, () => {
      assert.throws(() => renderInputFile(value), pattern);
    });
  }
});

describe("parseInputFile", () => {
  it("returns what renderInputFile rendered", () => {
    const value = input();
    assert.deepEqual(parseInputFile(renderInputFile(value)), value);
  });

  for (const [name, value, pattern] of INVALID) {
    it(`throws for ${name}`, () => {
      assert.throws(() => parseInputFile(JSON.stringify(value, null, 2)), pattern);
    });
  }

  it("throws saying the text does not parse when it is not JSON", () => {
    assert.throws(() => parseInputFile("{ not json"), /does not parse as JSON/);
  });

  it("throws for text that is not a string", () => {
    assert.throws(() => parseInputFile(undefined), /must be a string/);
  });
});
