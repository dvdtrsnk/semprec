import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync, deflateSync } from "node:zlib";

import {
  MEMORY_MARKER_PREFIX,
  TRUSTED_REVIEW_BOT_LOGINS,
  decodeMemory,
  parseMemory,
  selectMemoryComment,
} from "./memory.mjs";

// The real review memory of #551, as the bot wrote it.
const PR_551_PAYLOAD =
  "eNqllM1u1DAQgF/FypVt17FjJ1lOCLhwoWorONBqd2KPu2azzsr2bllVlXgInpAnYZKWH4EEAk6ezO+XmbHvigPG5IdQLMpZsYvDezR56W2xKOzB5pjCZp5wu4toitG+DPtth7FYKEX+awS7TGsgb9eVpbSN5sKYRrfKKFlV0hjDremctlxLUjUlZekg4WNUBQY70KBqJXijrXIGa6xF11hdNWXrSCG0FBRFnNYTm0XjH4ALM2y3GHL60eqdW64hrcnMpVSilKClg84AVk3FoVKmtV1nhdHQWiFBWC6gqZSribuSspRUWIvSwA9p/w857ntM36i0trYUKFTJnYZO6LYUToBzVVdrVRKgbKxToJVtSmGtk41s2rZrG9dwxymv88H6cJOKxbu7YoNHygqqMrWQWI8N3kEeK3VgNhjsfEcn3GCaW8gwT9HMzXrY4NngQ55H7CFTO1/aG3w+hIwf8unU0d4HLBainhUJ6Ud8Hsv0wy2ZDGS8GeKoSBl6PHkcBJksJhP9Lj8M6HKN7NXFi8GwIbDVxTFl3J4/FnxLKb9WXLEEx8SuqBSyFaSEMX/1u/AWn0ck9K7H1fwn61kcdvR5HLNNDqxDgrwqZqzbZwYuY2SZMLbDAYmiP7I/ZvCJ+UBBdDrf49PfE7HeH3CKWH1vK7VwNWNpmEqbOKR0EtFhxGBwzD+17ZT6BYGC6DoVJJMy72moBQGFacwx5SW1JPz9Hevhn0PjPqTpNbA+mX0a79rDg0C2MGQcpfvrWUFbMd69cQchk1JwoU94eyLUJa8XXC1K9YTzBR83dkMbSy4RDx7HDfoVatqdDL4n/bOzs/PXb16yzx8/sZIFvJ0xzgzE6NGOYsQ09IcHmSC3nsZjJ6aRb0S6vv8CiI2RUw==";

const PR_551_FINDING = {
  key: "a54c723e71",
  path: "backend/packages/data/src/chokePoint/relationEdgeContext.ts",
  line: 27,
  severity: "low",
  category: "stale-comment",
  description:
    'The JSDoc on `SystemRelationWriteContext` says "see `assertRelationSideCreatable`/`assertRelationPropertyWritable` below", but after the move only `assertRelationPropertyWritable` is in this file; `assertRelationSideCreatable` lives in `chokePoint.ts`, so the cross-reference is stale.',
  anchor: "",
  status: "open",
  first_seen_sha: "fb113d8602cc8695c53443ccc0dcbf6d063c5381",
  last_seen_sha: "fb113d8602cc8695c53443ccc0dcbf6d063c5381",
  runs: 1,
  discussion_id: "",
  note: "",
};

const PR_551_FINDING_CAMEL = {
  key: "a54c723e71",
  path: "backend/packages/data/src/chokePoint/relationEdgeContext.ts",
  line: 27,
  severity: "low",
  category: "stale-comment",
  description: PR_551_FINDING.description,
  anchor: "",
  status: "open",
  discussionId: "",
  firstSeenSha: "fb113d8602cc8695c53443ccc0dcbf6d063c5381",
  lastSeenSha: "fb113d8602cc8695c53443ccc0dcbf6d063c5381",
};

function memoryBody(payload) {
  return `🧠 **Review memory**\n\n| Finding | Status |\n|---|---|\n\n${MEMORY_MARKER_PREFIX}${payload} -->`;
}

function encode(value) {
  return deflateSync(Buffer.from(JSON.stringify(value), "utf-8"), { level: 9 }).toString("base64");
}

function memory(overrides = {}) {
  return { version: 1, project_id: "dvdtrsnk/semprec", pr_number: 551, findings: [{ ...PR_551_FINDING }], ...overrides };
}

function comment(id, author, createdAt, body = memoryBody("AAAA")) {
  return { id, author, createdAt, body };
}

test("TRUSTED_REVIEW_BOT_LOGINS is frozen and lists both review bots", () => {
  assert.deepEqual([...TRUSTED_REVIEW_BOT_LOGINS], ["github-actions[bot]", "bb-agent-relay[bot]"]);
  assert.ok(Object.isFrozen(TRUSTED_REVIEW_BOT_LOGINS));
});

test("selectMemoryComment returns the newest trusted comment containing the prefix", () => {
  const older = comment(1, "github-actions[bot]", "2026-09-01T10:00:00Z");
  const newer = comment(2, "bb-agent-relay[bot]", "2026-09-02T10:00:00Z");
  assert.equal(selectMemoryComment([newer, older]), newer);
  assert.equal(selectMemoryComment([older, newer]), newer);
});

test("selectMemoryComment ignores a newer comment by an untrusted author", () => {
  const trusted = comment(1, "github-actions[bot]", "2026-09-01T10:00:00Z");
  const spoofed = comment(2, "someone-else", "2026-09-03T10:00:00Z");
  assert.equal(selectMemoryComment([trusted, spoofed]), trusted);
});

test("selectMemoryComment ignores a trusted comment without the prefix", () => {
  const withMemory = comment(1, "github-actions[bot]", "2026-09-01T10:00:00Z");
  const plain = comment(2, "github-actions[bot]", "2026-09-03T10:00:00Z", "Code review: no findings.");
  assert.equal(selectMemoryComment([withMemory, plain]), withMemory);
});

test("selectMemoryComment returns null for an empty list or when nothing qualifies", () => {
  assert.equal(selectMemoryComment([]), null);
  assert.equal(
    selectMemoryComment([
      comment(1, "someone-else", "2026-09-01T10:00:00Z"),
      comment(2, "bb-agent-relay[bot]", "2026-09-02T10:00:00Z", "no marker here"),
    ]),
    null,
  );
});

test("selectMemoryComment resolves equal createdAt to the higher id", () => {
  const low = comment(5, "github-actions[bot]", "2026-09-01T10:00:00Z");
  const high = comment(9, "bb-agent-relay[bot]", "2026-09-01T10:00:00Z");
  assert.equal(selectMemoryComment([high, low]), high);
  assert.equal(selectMemoryComment([low, high]), high);
});

test("decodeMemory decodes the real #551 memory", () => {
  const decoded = decodeMemory(memoryBody(PR_551_PAYLOAD));
  assert.equal(decoded.pr_number, 551);
  assert.deepEqual(decoded.findings, [PR_551_FINDING]);
});

test("decodeMemory throws naming the extract stage when the prefix is missing", () => {
  assert.throws(() => decodeMemory("just a comment"), /review memory extract:/);
});

test("decodeMemory throws naming the base64 stage for a character outside the alphabet", () => {
  assert.throws(() => decodeMemory(memoryBody(`${PR_551_PAYLOAD.slice(0, 20)}-_${PR_551_PAYLOAD.slice(22)}`)), /review memory base64:/);
});

test("decodeMemory throws naming the inflate stage for valid base64 that is not zlib data", () => {
  const payload = Buffer.from("definitely not zlib data", "utf-8").toString("base64");
  assert.throws(() => decodeMemory(memoryBody(payload)), /review memory inflate:/);
});

test("decodeMemory throws naming the inflate stage for raw deflate data", () => {
  const payload = deflateRawSync(Buffer.from(JSON.stringify(memory()), "utf-8")).toString("base64");
  assert.throws(() => decodeMemory(memoryBody(payload)), /review memory inflate:/);
});

test("decodeMemory throws naming the json stage for zlib data that is not JSON", () => {
  const payload = deflateSync(Buffer.from("{not json", "utf-8")).toString("base64");
  assert.throws(() => decodeMemory(memoryBody(payload)), /review memory json:/);
});

test("decodeMemory throws naming the utf-8 stage for zlib data that is not UTF-8", () => {
  const payload = deflateSync(Buffer.from([0xff, 0xfe, 0xfd])).toString("base64");
  assert.throws(() => decodeMemory(memoryBody(payload)), /review memory utf-8:/);
});

test("parseMemory returns the #551 finding in camelCase", () => {
  const decoded = decodeMemory(memoryBody(PR_551_PAYLOAD));
  assert.deepEqual(parseMemory(decoded, 551), { findings: [PR_551_FINDING_CAMEL] });
});

test("parseMemory throws naming pr_number for another pull request", () => {
  const decoded = decodeMemory(memoryBody(PR_551_PAYLOAD));
  assert.throws(() => parseMemory(decoded, 552), /pr_number/);
});

test("parseMemory accepts mr_iid when pr_number is absent", () => {
  const { pr_number: _dropped, ...legacy } = memory({ mr_iid: 551 });
  const decoded = decodeMemory(memoryBody(encode(legacy)));
  assert.deepEqual(parseMemory(decoded, 551), { findings: [PR_551_FINDING_CAMEL] });
});

test("parseMemory throws naming pr_number when neither pr_number nor mr_iid is present", () => {
  const { pr_number: _dropped, ...noNumber } = memory();
  assert.throws(() => parseMemory(noNumber, 551), /pr_number/);
});

test("parseMemory throws when the value is not an object", () => {
  assert.throws(() => parseMemory(null, 551), /not an object/);
  assert.throws(() => parseMemory([], 551), /not an object/);
});

test("parseMemory throws naming findings when it is not an array", () => {
  assert.throws(() => parseMemory(memory({ findings: {} }), 551), /findings is not an array/);
});

test("parseMemory throws when a finding is not an object", () => {
  assert.throws(() => parseMemory(memory({ findings: ["x"] }), 551), /findings\[0\] is not an object/);
});

const invalidFindings = [
  ["a missing key", (f) => delete f.key, /findings\[0\]\.key/],
  ["an eleven-character key", (f) => (f.key = "a54c723e71b"), /findings\[0\]\.key/],
  ["an uppercase key", (f) => (f.key = "A54C723E71"), /findings\[0\]\.key/],
  ['line: "27"', (f) => (f.line = "27"), /findings\[0\]\.line/],
  ["a negative line", (f) => (f.line = -1), /findings\[0\]\.line/],
  ['severity: "info"', (f) => (f.severity = "info"), /findings\[0\]\.severity/],
  ['status: "closed"', (f) => (f.status = "closed"), /findings\[0\]\.status/],
  ['path: ""', (f) => (f.path = ""), /findings\[0\]\.path/],
  ["a missing path", (f) => delete f.path, /findings\[0\]\.path/],
  ["a non-string category", (f) => (f.category = 3), /findings\[0\]\.category/],
  ["a missing description", (f) => delete f.description, /findings\[0\]\.description/],
  ["a null anchor", (f) => (f.anchor = null), /findings\[0\]\.anchor/],
  ["a missing discussion_id", (f) => delete f.discussion_id, /findings\[0\]\.discussion_id/],
  ["a non-string first_seen_sha", (f) => (f.first_seen_sha = 1), /findings\[0\]\.first_seen_sha/],
  ["a missing last_seen_sha", (f) => delete f.last_seen_sha, /findings\[0\]\.last_seen_sha/],
];

for (const [name, mutate, pattern] of invalidFindings) {
  test(`parseMemory throws naming the field for a finding with ${name}`, () => {
    const value = memory();
    mutate(value.findings[0]);
    assert.throws(() => parseMemory(value, 551), pattern);
  });
}

test("parseMemory ignores unknown and unreturned fields whatever their shape", () => {
  const value = memory({ events: [42, null, "not an event"], notes: "x", verdict_state: {} });
  Object.assign(value.findings[0], { surprise: { nested: true }, runs: "many", note: 7 });
  assert.deepEqual(parseMemory(value, 551), { findings: [PR_551_FINDING_CAMEL] });
});
