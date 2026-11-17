import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseIssueModelTier, validateIssueModelMetadata } from "./model-tier.mjs";
for (const fixture of JSON.parse(readFileSync(new URL("./model-tier.fixtures.json", import.meta.url)))) test(fixture.name, () => assert.deepEqual(parseIssueModelTier(fixture.body), fixture.result));
test("oversized and non-string bodies fail at the boundary", () => { assert.deepEqual(parseIssueModelTier("x".repeat(60001)), { ok: false, error: "invalid" }); assert.equal(parseIssueModelTier(null).ok, false); });

test("publishing requires a nonempty rationale in Context", () => {
  const header = "**Blocked by:** none\n**Model tier:** high\n\n## Context\n";
  assert.equal(validateIssueModelMetadata(header + "Model tier rationale: Concurrent work crosses process boundaries.\n## Task\nDo work.").ok, true);
  for (const tail of ["## Task\nModel tier rationale: Wrong section.", "Model tier rationale: ", "No explanation.", "Model tier rationale: One.\nModel tier rationale: Two."])
    assert.deepEqual(validateIssueModelMetadata(header + tail), { ok: false, error: "rationale-missing" });
});
