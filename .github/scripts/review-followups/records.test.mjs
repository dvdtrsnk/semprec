import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseHarvestBlock, renderHarvestBlock, validateFindingRecord } from "./records.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "0123456789abcdef0123456789abcdef01234567";

function record(overrides = {}) {
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
    lastSeenSha: SHA_B,
    ...overrides,
  };
}

function without(field) {
  const value = record();
  delete value[field];
  return value;
}

function harvest() {
  return {
    prs: [301, 305],
    findings: [record(), record({ pr: 305, key: "fedcba9876", severity: "high", touchedAfterLastSeen: true })],
  };
}

const DATA_MARKER = "<!-- crb-followup-data:v1 -->";

describe("validateFindingRecord", () => {
  it("returns a valid record", () => {
    const value = record();
    assert.equal(validateFindingRecord(value), value);
  });

  it("accepts the empty and boundary values each field allows", () => {
    const value = record({
      line: 0,
      anchor: "",
      description: "x".repeat(299) + "…",
      descriptionTruncated: true,
      discussionId: "",
      threadResolved: true,
      replies: [
        { author: "a", excerpt: "" },
        { author: "b", excerpt: "y".repeat(200) },
        { author: "c", excerpt: "z" },
      ],
      pathExists: false,
      touchedAfterLastSeen: false,
      laterPrsTouchingPath: 7,
      firstSeenSha: "",
      lastSeenSha: "",
    });
    assert.equal(validateFindingRecord(value), value);
  });

  for (const value of [null, undefined, "record", 1, []]) {
    it(`rejects a non-object ${JSON.stringify(value)}`, () => {
      assert.throws(() => validateFindingRecord(value), /must be an object/);
    });
  }

  const fields = Object.keys(record());
  for (const field of fields) {
    it(`rejects a record missing "${field}"`, () => {
      assert.throws(() => validateFindingRecord(without(field)), {
        message: new RegExp(`"${field}" is missing`),
      });
    });
  }

  const invalid = {
    pr: [0, -1, 1.5, "301", null],
    key: ["012345678", "0123456789a", "ABCDEF0123", "ghijklmnop", 123456789, ""],
    severity: ["info", "Medium", "", null],
    category: ["", 3, null],
    path: ["", null, []],
    line: [-1, 1.5, "42", null],
    anchor: ["abcdef012", "ABCDEF0123", null, 5],
    description: ["x".repeat(301), null, 3],
    descriptionTruncated: ["false", 0, null],
    discussionId: ["issue:123", "12a", 123, null],
    threadResolved: ["true", 1, null],
    replies: [
      [
        { author: "a", excerpt: "" },
        { author: "b", excerpt: "" },
        { author: "c", excerpt: "" },
        { author: "d", excerpt: "" },
      ],
      null,
      "reply",
      {},
    ],
    pathExists: ["true", null],
    touchedAfterLastSeen: ["yes", 0, undefined],
    laterPrsTouchingPath: [-1, 0.5, "0", null],
    firstSeenSha: ["a".repeat(39), "A".repeat(40), "a".repeat(41), null],
    lastSeenSha: ["b".repeat(39), "g".repeat(40), null],
  };
  assert.deepEqual(Object.keys(invalid), fields);

  for (const [field, values] of Object.entries(invalid)) {
    for (const value of values) {
      it(`rejects "${field}" = ${JSON.stringify(value)}`, () => {
        assert.throws(() => validateFindingRecord(record({ [field]: value })), {
          message: new RegExp(`"${field}"`),
        });
      });
    }
  }

  const invalidReplies = [
    ["replies\\[0\\]\\.excerpt", { author: "a", excerpt: "y".repeat(201) }],
    ["replies\\[0\\]\\.excerpt", { author: "a" }],
    ["replies\\[0\\]\\.author", { author: "", excerpt: "" }],
    ["replies\\[0\\]\\.author", { excerpt: "" }],
    ["replies\\[0\\]", "a reply"],
    ["replies\\[0\\]", { author: "a", excerpt: "", date: "2026-09-26" }],
  ];
  for (const [field, reply] of invalidReplies) {
    it(`rejects the reply ${JSON.stringify(reply).slice(0, 60)}`, () => {
      assert.throws(() => validateFindingRecord(record({ replies: [reply] })), {
        message: new RegExp(`"${field}"`),
      });
    });
  }

  it("rejects a record with an extra field", () => {
    assert.throws(() => validateFindingRecord(record({ status: "open" })), {
      message: /unexpected field "status"/,
    });
  });
});

describe("renderHarvestBlock and parseHarvestBlock", () => {
  it("round-trips through surrounding Markdown", () => {
    const data = harvest();
    const body = `# Harvest\n\nSome findings to triage.\n\n${renderHarvestBlock(data)}\nTrailing text.\n`;
    assert.deepEqual(parseHarvestBlock(body), data);
  });

  it("round-trips an empty findings list and a CRLF body", () => {
    const data = { prs: [266], findings: [] };
    const body = `Intro\r\n${renderHarvestBlock(data).replaceAll("\n", "\r\n")}Outro`;
    assert.deepEqual(parseHarvestBlock(body), data);
  });

  it("writes the marker, a json fence and two-space indented JSON", () => {
    const block = renderHarvestBlock({ prs: [266], findings: [] });
    assert.equal(
      block,
      `${DATA_MARKER}\n\`\`\`json\n{\n  "version": 1,\n  "prs": [\n    266\n  ],\n  "findings": []\n}\n\`\`\`\n`,
    );
  });

  it("escapes every < so a quoted marker cannot form an HTML comment", () => {
    const description = "Quoted <!-- crb-followup:v1 pr=1 key=0123456789 --> marker";
    const data = {
      prs: [301],
      findings: [record({ description, replies: [{ author: "a", excerpt: `<!-- ${DATA_MARKER} -->` }] })],
    };
    const block = renderHarvestBlock(data);
    const fenced = block.slice(block.indexOf("```json") + "```json".length, block.lastIndexOf("```"));
    assert.ok(!fenced.includes("<"));
    assert.ok(fenced.includes("\\u003c!-- crb-followup:v1"));
    const parsed = parseHarvestBlock(`Before\n\n${block}`);
    assert.equal(parsed.findings[0].description, description);
    assert.deepEqual(parsed, data);
  });

  const block = (json) => `Intro\n\n${DATA_MARKER}\n\`\`\`json\n${json}\n\`\`\`\nOutro`;
  const json = (value) => JSON.stringify(value, null, 2);
  const valid = { version: 1, ...harvest() };

  it("parses a hand-written valid block", () => {
    assert.deepEqual(parseHarvestBlock(block(json(valid))), harvest());
  });

  const unparseable = [
    ["no data marker", "Just a body\n```json\n{}\n```\n", /no .* marker/],
    ["two data markers", `${block(json(valid))}\n\n${block(json(valid))}`, /2 .* markers/],
    ["a marker inside a line", `Text ${DATA_MARKER}\n\`\`\`json\n${json(valid)}\n\`\`\``, /line of its own/],
    ["a marker at the end of the body", `Intro\n${DATA_MARKER}`, /fence/],
    ["a marker not followed by a json fence", `${DATA_MARKER}\n\n\`\`\`json\n${json(valid)}\n\`\`\``, /fence/],
    ["a marker followed by an untyped fence", `${DATA_MARKER}\n\`\`\`\n${json(valid)}\n\`\`\``, /fence/],
    ["an unclosed fence", `${DATA_MARKER}\n\`\`\`json\n${json(valid)}\n`, /never closed/],
    ["invalid JSON", block("{ version: 1 }"), /not valid JSON/],
    ["a JSON array", block("[]"), /JSON object/],
    ["version 2", block(json({ ...valid, version: 2 })), /"version"/],
    ["a missing version", block(json(harvest())), /"version"/],
    ["an extra top-level field", block(json({ ...valid, harvestedAt: "today" })), /"harvestedAt"/],
    ["a missing prs", block(json({ version: 1, findings: [] })), /"prs"/],
    ["an empty prs", block(json({ version: 1, prs: [], findings: [] })), /"prs"/],
    ["an unsorted prs", block(json({ version: 1, prs: [305, 301], findings: [] })), /"prs"/],
    ["a duplicate in prs", block(json({ version: 1, prs: [301, 301], findings: [] })), /"prs"/],
    ["a non-integer pr", block(json({ version: 1, prs: ["301"], findings: [] })), /"prs\[0\]"/],
    ["a missing findings", block(json({ version: 1, prs: [301] })), /"findings"/],
    [
      "a record whose pr is not in prs",
      block(json({ version: 1, prs: [301], findings: [record({ pr: 302 })] })),
      /not in "prs"/,
    ],
    [
      "a duplicate (pr, key)",
      block(json({ version: 1, prs: [301], findings: [record(), record({ line: 7 })] })),
      /repeats pr 301 key 0123456789/,
    ],
    [
      "an invalid record",
      block(json({ version: 1, prs: [301], findings: [record({ severity: "info" })] })),
      /"findings\[0\]".*"severity"/,
    ],
  ];
  for (const [name, body, message] of unparseable) {
    it(`parseHarvestBlock throws for ${name}`, () => {
      assert.throws(() => parseHarvestBlock(body), { message });
    });
  }

  it("parseHarvestBlock throws for a non-string body", () => {
    assert.throws(() => parseHarvestBlock(undefined), /must be a string/);
  });

  it("accepts the same (key) under two different prs", () => {
    const data = { prs: [301, 305], findings: [record(), record({ pr: 305 })] };
    assert.deepEqual(parseHarvestBlock(renderHarvestBlock(data)), data);
  });

  const unrenderable = [
    ["an invalid record", { prs: [301], findings: [record({ key: "012345678" })] }, /"key"/],
    ["an unsorted prs", { prs: [305, 301], findings: [] }, /"prs"/],
    ["an empty prs", { prs: [], findings: [] }, /"prs"/],
    ["a duplicate in prs", { prs: [301, 301], findings: [] }, /"prs"/],
    ["a record whose pr is not in prs", { prs: [301], findings: [record({ pr: 302 })] }, /not in "prs"/],
    ["a duplicate (pr, key)", { prs: [301], findings: [record(), record()] }, /repeats/],
    ["a findings that is not an array", { prs: [301], findings: {} }, /"findings"/],
    ["an extra field", { prs: [301], findings: [], version: 1 }, /"version"/],
    ["a non-object", null, /must be an object/],
  ];
  for (const [name, data, message] of unrenderable) {
    it(`renderHarvestBlock throws for ${name}`, () => {
      assert.throws(() => renderHarvestBlock(data), { message });
    });
  }
});
