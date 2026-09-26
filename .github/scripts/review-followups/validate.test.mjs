import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { renderInputFile } from "./input-file.mjs";
import { VERDICTS, validateProposal } from "./validate.mjs";

const SHA_A = "a".repeat(40);
const H = 612;

function entry(pr, key) {
  return {
    pr,
    key,
    severity: "medium",
    category: "error handling",
    path: "backend/packages/data/src/store.ts",
    line: 42,
    anchor: "abcdef0123",
    description: "A catch maps every failure onto a validation error.",
    descriptionTruncated: false,
    discussionId: "2345678901",
    threadResolved: false,
    replies: [],
    pathExists: true,
    touchedAfterLastSeen: null,
    laterPrsTouchingPath: 0,
    firstSeenSha: SHA_A,
    lastSeenSha: SHA_A,
    fullText: null,
    suggestedFix: null,
    threadReplies: [],
  };
}

const F1 = { pr: 301, key: "0123456789" };
const F2 = { pr: 301, key: "abcdef0123" };
const F3 = { pr: 305, key: "fedcba9876" };
const F4 = { pr: 305, key: "1111111111" };
const F5 = { pr: 307, key: "2222222222" };

function input() {
  return {
    version: 1,
    harvestIssue: H,
    findings: [F1, F2, F3, F4, F5].map(({ pr, key }) => entry(pr, key)),
    prSummaries: [],
    openIssues: [],
  };
}

function body({ blockedBy = "none", touches = "- backend/packages/data/src/store.ts", task = "Rethrow unknown errors.", extra = "" } = {}) {
  return [
    `**Blocked by:** ${blockedBy}`,
    "",
    "## Context",
    "",
    `Found in review.${extra}`,
    "",
    "## Task",
    "",
    task,
    "",
    "## Touches",
    "",
    touches,
    "",
    "## Scope",
    "",
    "### In scope",
    "",
    "- The fix.",
    "",
    "### Out of scope",
    "",
    "- Everything else.",
    "",
    "## Acceptance criteria",
    "",
    "1. It works.",
    "",
  ].join("\n");
}

function proposal() {
  return {
    version: 1,
    harvestIssue: H,
    epic: { title: `[followups-${H}] Review follow-ups — epic`, body: `Follow-ups from #${H}.` },
    issues: [
      { id: "a", title: `[followups-${H} 01/03] Fix the store`, body: body(), findings: [F1] },
      {
        id: "b-fix",
        title: `[followups-${H} 02/03] Fix the handler`,
        body: body({ blockedBy: "#12, {{draft:a}}", extra: " Builds on {{draft:a}}." }),
        findings: [F2],
      },
      {
        id: "c",
        title: `[followups-${H} 03/03] Fix the view`,
        body: body({ blockedBy: "{{draft:b-fix}}" }),
        findings: [F3],
      },
    ],
    rejected: [
      { pr: F4.pr, key: F4.key, verdict: "already-tracked", reason: "Issue #40 covers it.", trackedBy: 40 },
      { pr: F5.pr, key: F5.key, verdict: "invalid", reason: "The catch already rethrows." },
    ],
    advisories: ["Consider a lint rule for broad catches."],
  };
}

/** Asserts that `violations` holds exactly one entry and that it contains every fragment. */
function assertOne(violations, ...fragments) {
  assert.equal(violations.length, 1, `expected one violation, got ${JSON.stringify(violations)}`);
  for (const fragment of fragments) {
    assert.ok(violations[0].includes(fragment), `${JSON.stringify(violations[0])} lacks ${JSON.stringify(fragment)}`);
  }
}

function withDraftBody(index, text) {
  const p = proposal();
  p.issues[index].body = text;
  return p;
}

describe("VERDICTS", () => {
  it("is the frozen list of rejection verdicts", () => {
    assert.deepEqual(VERDICTS, ["already-fixed", "invalid", "not-worth", "already-tracked"]);
    assert.ok(Object.isFrozen(VERDICTS));
  });
});

describe("validateProposal", () => {
  it("accepts a complete proposal", () => {
    assert.deepEqual(validateProposal(input(), proposal()), []);
  });

  describe("completeness", () => {
    it("reports a missing finding", () => {
      const p = proposal();
      p.rejected.pop();
      assertOne(validateProposal(input(), p), "pr 307, key 2222222222", "in no draft");
    });

    it("reports a finding in two drafts", () => {
      const p = proposal();
      p.issues[1].findings.push(F1);
      assertOne(validateProposal(input(), p), "pr 301, key 0123456789", "2 times", 'draft "a"', 'draft "b-fix"');
    });

    it("reports a finding in a draft and in rejected", () => {
      const p = proposal();
      p.rejected.push({ pr: F1.pr, key: F1.key, verdict: "not-worth", reason: "Cosmetic." });
      assertOne(validateProposal(input(), p), "pr 301, key 0123456789", 'draft "a"', "rejected");
    });

    it("reports a finding not in the input", () => {
      const p = proposal();
      p.issues[0].findings.push({ pr: 999, key: "3333333333" });
      assertOne(validateProposal(input(), p), "pr 999, key 3333333333", "not in the input");
    });
  });

  describe("rejections", () => {
    function withRejection(rejection) {
      const p = proposal();
      p.rejected[1] = { pr: F5.pr, key: F5.key, ...rejection };
      return p;
    }

    it("reports an unknown verdict", () => {
      assertOne(validateProposal(input(), withRejection({ verdict: "wontfix", reason: "No." })), "rejected[1]", "verdict");
    });

    it("reports a blank reason", () => {
      assertOne(validateProposal(input(), withRejection({ verdict: "invalid", reason: "  " })), "rejected[1]", "reason");
    });

    it("reports already-tracked without trackedBy", () => {
      assertOne(validateProposal(input(), withRejection({ verdict: "already-tracked", reason: "Tracked." })), "trackedBy");
    });

    it("reports already-tracked with a trackedBy that is not a positive integer", () => {
      const p = withRejection({ verdict: "already-tracked", reason: "Tracked.", trackedBy: "#40" });
      assertOne(validateProposal(input(), p), "trackedBy");
    });

    it("reports not-worth with trackedBy", () => {
      const p = withRejection({ verdict: "not-worth", reason: "Cosmetic.", trackedBy: 40 });
      assertOne(validateProposal(input(), p), "trackedBy", "only allowed");
    });

    it("reports a malformed key and an extra field", () => {
      const p = proposal();
      p.rejected[1] = { pr: F5.pr, key: "XYZ", verdict: "invalid", reason: "No.", note: "x" };
      const violations = validateProposal(input(), p);
      assert.ok(violations.some((v) => v.includes('unexpected field "note"')));
      assert.ok(violations.some((v) => v.includes('field "key"')));
      assert.ok(violations.some((v) => v.includes("pr 307, key 2222222222") && v.includes("in no draft")));
    });
  });

  describe("titles", () => {
    function withTitle(title) {
      const p = proposal();
      p.issues[0].title = title;
      return p;
    }

    for (const [name, title] of [
      ["an unpadded number", `[followups-${H} 1/3] Fix the store`],
      ["a gap in numbering", `[followups-${H} 04/03] Fix the store`],
      ["a wrong total", `[followups-${H} 01/04] Fix the store`],
      ["the wrong harvest number", `[followups-611 01/03] Fix the store`],
      ["an empty text", `[followups-${H} 01/03]  `],
    ]) {
      it(`reports ${name}`, () => {
        assertOne(validateProposal(input(), withTitle(title)), 'draft "a" title');
      });
    }
  });

  describe("Blocked-by line", () => {
    it("reports a body whose first line is not the Blocked-by line", () => {
      assertOne(validateProposal(input(), withDraftBody(0, `Intro.\n${body()}`)), 'draft "a"', "must start with");
    });

    it("reports none mixed with a reference", () => {
      assertOne(validateProposal(input(), withDraftBody(1, body({ blockedBy: "none, #12" }))), 'draft "b-fix"', '"none"');
    });

    it("reports a reference to the harvest issue", () => {
      assertOne(validateProposal(input(), withDraftBody(0, body({ blockedBy: `#${H}` }))), 'draft "a"', "harvest issue");
    });

    it("reports a reference to a later draft", () => {
      assertOne(validateProposal(input(), withDraftBody(0, body({ blockedBy: "{{draft:c}}" }))), 'draft "a"', "earlier");
    });

    it("reports a reference to the draft itself", () => {
      assertOne(validateProposal(input(), withDraftBody(0, body({ blockedBy: "{{draft:a}}" }))), 'draft "a"', "earlier");
    });

    it("reports a reference to an unknown draft", () => {
      assertOne(validateProposal(input(), withDraftBody(1, body({ blockedBy: "{{draft:zzz}}" }))), "unknown draft");
    });

    it("reports an empty reference list", () => {
      assertOne(validateProposal(input(), withDraftBody(0, body({ blockedBy: "" }))), 'draft "a"', "must start with");
    });
  });

  describe("headings", () => {
    it("reports a missing heading", () => {
      const text = body().replace("## Touches\n", "");
      assertOne(validateProposal(input(), withDraftBody(0, text)), 'draft "a"', "## Touches");
    });

    it("reports headings out of order", () => {
      const text = body()
        .replace("## Context", "@@")
        .replace("## Task", "## Context")
        .replace("@@", "## Task");
      assertOne(validateProposal(input(), withDraftBody(0, text)), 'draft "a"', "order");
    });

    it("reports a repeated heading", () => {
      const text = `${body()}\n### Out of scope\n`;
      assertOne(validateProposal(input(), withDraftBody(0, text)), 'draft "a"', "### Out of scope", "2 times");
    });
  });

  describe("placeholders", () => {
    it("reports an unknown draft id", () => {
      assertOne(validateProposal(input(), withDraftBody(0, body({ extra: " See {{draft:x}}." }))), "unknown draft", "{{draft:x}}");
    });

    it("reports the draft itself", () => {
      assertOne(validateProposal(input(), withDraftBody(0, body({ extra: " See {{draft:a}}." }))), "references itself");
    });

    it("accepts a later draft outside the Blocked-by line", () => {
      assert.deepEqual(validateProposal(input(), withDraftBody(0, body({ extra: " Then {{draft:c}}." }))), []);
    });

    it("reports a malformed placeholder", () => {
      assertOne(validateProposal(input(), withDraftBody(0, body({ extra: " See {{draft:b-fix." }))), "malformed");
    });

    it("reports a placeholder in the epic body", () => {
      const p = proposal();
      p.epic.body = `From #${H}. First {{draft:a}}.`;
      assertOne(validateProposal(input(), p), "epic body", "{{draft:");
    });
  });

  describe("markers", () => {
    it("reports a marker in a draft body", () => {
      assertOne(validateProposal(input(), withDraftBody(0, body({ extra: " <!-- crb-followup:v1 -->" }))), 'draft "a"', "marker");
    });

    it("reports a marker in the epic body", () => {
      const p = proposal();
      p.epic.body = `From #${H}. <!-- crb-followup:v1 -->`;
      assertOne(validateProposal(input(), p), "epic body", "marker");
    });
  });

  describe("length", () => {
    it("reports a draft body of 60,001 characters and accepts 60,000", () => {
      const base = body();
      const long = `${base}${"x".repeat(60001 - base.length)}`;
      assert.equal(long.length, 60001);
      assertOne(validateProposal(input(), withDraftBody(0, long)), 'draft "a"', "60001");
      assert.deepEqual(validateProposal(input(), withDraftBody(0, long.slice(0, 60000))), []);
    });

    it("reports an epic body of 60,001 characters", () => {
      const p = proposal();
      p.epic.body = `#${H} ${"x".repeat(60001 - `#${H} `.length)}`;
      assertOne(validateProposal(input(), p), "epic", "60001");
    });
  });

  describe("epic", () => {
    it("reports two drafts with a null epic", () => {
      const p = proposal();
      p.rejected.push({ pr: F3.pr, key: F3.key, verdict: "not-worth", reason: "Cosmetic." });
      p.issues.pop();
      p.issues.forEach((draft, i) => {
        draft.title = draft.title.replace(`0${i + 1}/03`, `0${i + 1}/02`);
      });
      assert.deepEqual(validateProposal(input(), p), []);
      p.epic = null;
      assertOne(validateProposal(input(), p), "epic must be present");
    });

    it("reports one draft with an epic, and accepts it without", () => {
      const p = proposal();
      p.issues = [{ ...p.issues[0], title: `[followups-${H} 01/01] Fix all`, findings: [F1, F2, F3] }];
      assertOne(validateProposal(input(), p), "epic must be null");
      p.epic = null;
      assert.deepEqual(validateProposal(input(), p), []);
    });

    it("reports a non-object epic without throwing", () => {
      for (const value of [5, [], "epic"]) {
        const p = proposal();
        p.epic = value;
        assertOne(validateProposal(input(), p), "epic must be an object");
      }
    });

    it("reports a non-string epic body", () => {
      const p = proposal();
      p.epic.body = null;
      assertOne(validateProposal(input(), p), "epic", '"body"');
    });

    it("reports an empty epic body", () => {
      const p = proposal();
      p.epic.body = "";
      assertOne(validateProposal(input(), p), "epic", '"body"');
    });

    it("reports an epic title without the epic suffix", () => {
      const p = proposal();
      p.epic.title = `[followups-${H}] Review follow-ups`;
      assertOne(validateProposal(input(), p), "epic title");
    });

    it("reports an epic title with the wrong harvest number", () => {
      const p = proposal();
      p.epic.title = `[followups-611] Review follow-ups — epic`;
      assertOne(validateProposal(input(), p), "epic title");
    });

    it("reports an epic body without the harvest issue link", () => {
      const p = proposal();
      p.epic.body = "Follow-ups.";
      assertOne(validateProposal(input(), p), "epic body", `#${H}`);
    });

    it("reports an epic body linking only a longer number", () => {
      const p = proposal();
      p.epic.body = `Follow-ups from #${H}1.`;
      assertOne(validateProposal(input(), p), "epic body", `#${H}`);
    });

    it("reports an epic with an extra field", () => {
      const p = proposal();
      p.epic.labels = [];
      assertOne(validateProposal(input(), p), "epic", 'unexpected field "labels"');
    });
  });

  describe("protected paths", () => {
    it("reports a workflow path without maintainer-implemented", () => {
      const text = body({ touches: "- .github/workflows/ci.yml" });
      assertOne(validateProposal(input(), withDraftBody(0, text)), 'draft "a"', "maintainer-implemented");
    });

    it("accepts a workflow path with maintainer-implemented in the Task", () => {
      const text = body({ touches: "- .github/workflows/ci.yml", task: "maintainer-implemented: edit the workflow." });
      assert.deepEqual(validateProposal(input(), withDraftBody(0, text)), []);
    });

    it("does not count maintainer-implemented outside the Task", () => {
      const text = body({ touches: "- .relay/config.yml", extra: " maintainer-implemented" });
      assertOne(validateProposal(input(), withDraftBody(0, text)), "maintainer-implemented");
    });

    it("reports the protected-paths script but not a sibling script", () => {
      const guarded = body({ touches: "- `.github/scripts/check-protected-paths.mjs`" });
      assertOne(validateProposal(input(), withDraftBody(0, guarded)), "maintainer-implemented");
      const sibling = body({ touches: "- .github/scripts/check-review-scope.mjs\n- docs/.relay/x.md" });
      assert.deepEqual(validateProposal(input(), withDraftBody(0, sibling)), []);
    });

    it("ignores a protected path mentioned outside Touches", () => {
      assert.deepEqual(validateProposal(input(), withDraftBody(0, body({ extra: " Unlike .relay/config.yml." }))), []);
    });
  });

  describe("shape", () => {
    it("reports a non-object proposal without throwing", () => {
      for (const value of [null, [], "x", 3]) {
        assertOne(validateProposal(input(), value), "proposal must be an object");
      }
    });

    it("reports issues that is not an array", () => {
      const p = proposal();
      p.issues = {};
      const violations = validateProposal(input(), p);
      assert.deepEqual(violations, ['proposal field "issues" must be an array']);
    });

    it("reports a draft with an extra field", () => {
      const p = proposal();
      p.issues[0].labels = ["x"];
      assertOne(validateProposal(input(), p), 'draft "a"', 'unexpected field "labels"');
    });

    it("reports a duplicate draft id", () => {
      const p = proposal();
      p.issues[2].id = "a";
      p.issues[2].body = body({ blockedBy: "{{draft:b-fix}}" });
      assertOne(validateProposal(input(), p), 'draft "a"', "repeats");
    });

    it("reports an id that is not kebab-case", () => {
      const p = proposal();
      p.issues[0].id = "Fix_A";
      p.issues[1].body = body({ blockedBy: "{{draft:Fix_A}}" });
      assertOne(validateProposal(input(), p), 'draft "Fix_A"', "kebab-case");
    });

    it("reports malformed drafts and findings without throwing", () => {
      const p = proposal();
      p.issues.push(7, { id: 3, title: null, body: null, findings: [] }, { id: "d", title: "", body: "", findings: [{ pr: 0 }] });
      const violations = validateProposal(input(), p);
      assert.ok(violations.includes("issues[3] must be an object"));
      assert.ok(violations.includes('issues[4] field "id" must be kebab-case'));
      assert.ok(violations.includes('issues[4] field "body" must be a string'));
      assert.ok(violations.includes('issues[4] field "findings" must be a non-empty array'));
      assert.ok(violations.includes('draft "d" findings[0] is missing field "key"'));
    });

    it("reports top-level field violations together", () => {
      const p = proposal();
      p.version = 2;
      p.harvestIssue = 1;
      p.advisories = [1];
      p.extra = true;
      delete p.rejected;
      const violations = validateProposal(input(), p);
      assert.deepEqual(violations.sort(), [
        'proposal field "advisories" must be an array of strings',
        'proposal field "harvestIssue" must be 612',
        'proposal field "rejected" must be an array',
        'proposal field "version" must be 1',
        'proposal has unexpected field "extra"',
        'proposal is missing field "rejected"',
      ]);
    });
  });
});

describe("CLI", () => {
  const script = fileURLToPath(new URL("./validate.mjs", import.meta.url));
  const dir = mkdtempSync(path.join(tmpdir(), "validate-test-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  const inputPath = path.join(dir, "input.json");
  writeFileSync(inputPath, renderInputFile(input()));

  function writeProposal(name, text) {
    const file = path.join(dir, name);
    writeFileSync(file, text);
    return file;
  }

  function run(...args) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    return { status: result.status, lines: `${result.stdout}${result.stderr}`.split("\n").filter((line) => line !== "") };
  }

  it("exits 0 with an ok line for a valid proposal", () => {
    const file = writeProposal("valid.json", JSON.stringify(proposal()));
    const { status, lines } = run("--input", inputPath, "--proposal", file);
    assert.equal(status, 0);
    assert.deepEqual(lines, ["ok 3 drafts, 2 rejected, 5 findings, 1 advisories"]);
  });

  it("exits 1 listing each violation for an invalid proposal", () => {
    const p = proposal();
    p.version = 2;
    p.rejected.pop();
    const file = writeProposal("invalid.json", JSON.stringify(p));
    const { status, lines } = run("--proposal", file, "--input", inputPath);
    assert.equal(status, 1);
    assert.deepEqual(lines, [
      '- proposal field "version" must be 1',
      "- finding (pr 307, key 2222222222) is in no draft and not rejected",
    ]);
  });

  it("exits 1 with one line for a missing file", () => {
    const { status, lines } = run("--input", inputPath, "--proposal", path.join(dir, "absent.json"));
    assert.equal(status, 1);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^cannot read --proposal file .*absent\.json/);
  });

  it("exits 1 with one line for invalid proposal JSON", () => {
    const file = writeProposal("broken.json", "{");
    const { status, lines } = run("--input", inputPath, "--proposal", file);
    assert.equal(status, 1);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^--proposal file .* does not parse as JSON/);
  });

  it("exits 1 with one line for an invalid input file", () => {
    const badInput = writeProposal("bad-input.json", "{}");
    const file = writeProposal("valid2.json", JSON.stringify(proposal()));
    const { status, lines } = run("--input", badInput, "--proposal", file);
    assert.equal(status, 1);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^invalid --input file/);
  });

  it("exits 1 with one line for a missing argument", () => {
    for (const args of [["--input", inputPath], ["--input"], ["--input", inputPath, "--proposal"]]) {
      const { status, lines } = run(...args);
      assert.equal(status, 1);
      assert.equal(lines.length, 1);
      assert.match(lines[0], /missing/);
    }
  });

  it("exits 1 with one line for an unknown argument", () => {
    const { status, lines } = run("--input", inputPath, "--proposal", inputPath, "--dry-run", "x");
    assert.equal(status, 1);
    assert.deepEqual(lines, ['unknown argument "--dry-run"']);
  });
});
