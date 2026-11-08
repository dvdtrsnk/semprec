import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { reviewBotDisabled } from "./review-bot-disabled.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "review-policy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

for (const enabled of [true, false]) {
  test(`policy enabled=${enabled} reaches the real CLI`, (t) => {
    const path = join(fixture(t), "policy.json");
    writeFileSync(path, JSON.stringify({ enabled, reason: "Owner decision" }));
    assert.equal(reviewBotDisabled(path), !enabled);
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL("./review-bot-disabled.mjs", import.meta.url)), path], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stdout.trim(), String(!enabled));
  });
}

for (const value of [null, [], {}, { enabled: "false", reason: "pause" }, { enabled: false, reason: " " }, { enabled: false, reason: 1 }]) {
  test(`invalid policy fails closed: ${JSON.stringify(value)}`, (t) => {
    const path = join(fixture(t), "policy.json");
    writeFileSync(path, JSON.stringify(value));
    assert.throws(() => reviewBotDisabled(path), /Review policy requires/);
  });
}

test("missing and malformed files never become a review pause", (t) => {
  const path = join(fixture(t), "policy.json");
  assert.throws(() => reviewBotDisabled(path), /ENOENT/);
  writeFileSync(path, "not JSON");
  assert.throws(() => reviewBotDisabled(path), SyntaxError);
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL("./review-bot-disabled.mjs", import.meta.url)), path], { encoding: "utf8" });
  assert.notEqual(cli.status, 0);
  assert.equal(cli.stdout, "");
});

const workflow = readFileSync(new URL("../workflows/code-review.yml", import.meta.url), "utf8");
const bypass = workflow.match(/      - name: Report owner-authorized review pause\n[\s\S]*?        run: \|\n([\s\S]*?)\n      # Relay reviews/)[1].replace(/^          /gm, "").trim();

test("Actions gates all provider/delegation/finalizer steps on a valid enabled policy", () => {
  assert.ok(workflow.indexOf("name: Checkout semprec") < workflow.indexOf("name: Read owner review policy"));
  for (const step of ["Relay delegation", "Checkout code-review-bot (private)", "Install Claude Code CLI", "Run review", "Finalize interrupted code-review check"]) {
    const block = workflow.split(`      - name: ${step}\n`)[1]?.split("      - name:")[0];
    assert.ok(block, step);
    assert.match(block, /if: .*steps.policy.outputs.disabled == 'false'/, step);
  }
  const policy = workflow.split("      - name: Read owner review policy\n")[1].split("      - name:")[0];
  assert.match(policy, /disabled=\$\(node .*\)\n\s+echo/);
});

for (const scenario of ["current", "stale", "read-failure", "write-failure"]) {
  test(`pause check publication: ${scenario}`, (t) => {
    const dir = fixture(t);
    const sha = "a".repeat(40);
    writeFileSync(join(dir, "git"), `#!/bin/sh\nprintf '%s\\n' '${sha}'\n`, { mode: 0o755 });
    writeFileSync(join(dir, "gh"), `#!/bin/sh
if [ "$2" = '--method' ]; then
  cat > "$PAYLOAD"
  [ "$SCENARIO" != write-failure ]
else
  [ "$SCENARIO" != read-failure ] || exit 1
  if [ "$SCENARIO" = stale ]; then printf '%040d\\n' 0; else printf '%s\\n' '${sha}'; fi
fi
`, { mode: 0o755 });
    const payload = join(dir, "payload.json");
    const result = spawnSync("bash", ["-c", bypass], { encoding: "utf8", env: {
      ...process.env, PATH: `${dir}:${process.env.PATH}`, SCENARIO: scenario, PAYLOAD: payload,
      GITHUB_REPOSITORY: "dvdtrsnk/semprec", PR_NUMBER: "1292", GITHUB_STEP_SUMMARY: join(dir, "summary"),
    } });
    if (scenario === "current") {
      assert.equal(result.status, 0, result.stderr);
      const check = JSON.parse(readFileSync(payload, "utf8"));
      assert.equal(check.head_sha, sha);
      assert.equal(check.name, "code-review");
      assert.equal(check.conclusion, "neutral");
      assert.match(check.output.summary, /No automated review verdict/);
    } else {
      assert.notEqual(result.status, 0);
      if (scenario !== "write-failure") assert.throws(() => readFileSync(payload), /ENOENT/);
    }
  });
}

test("Relay reads policy before review and routes only the pause to verification/passed", () => {
  for (const [name, target] of [["implement-issue", "verify-backend"], ["review-pull-request", "passed"]]) {
    const text = readFileSync(new URL(`../../.relay/workflows/${name}.md`, import.meta.url), "utf8");
    assert.ok(text.indexOf("id: review-policy") < text.indexOf("uses: review-pipeline"));
    const paused = text.split("  - id: review-paused\n")[1].split("  - id:")[0];
    assert.match(paused, /if: "\{\{steps.review-policy.output\}\}"/);
    assert.ok(paused.includes(`on-success: { goto: ${target} }`));
    if (name === "review-pull-request") {
      assert.match(text, /in: checkout\n    ref: base/);
      assert.match(paused, /conclusion: neutral/);
    }
  }
});
