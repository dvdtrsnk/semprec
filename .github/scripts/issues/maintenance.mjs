#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { readBounded } from "./records.mjs";
import { sweepLocalEpics } from "./epics.mjs";
import { clientFromEnv } from "../review-followups/github.mjs";
const exec = promisify(execFile);
const root = process.cwd();
const git = async args => (await exec("git", args, { cwd: root, timeout: 60000, maxBuffer: 4_000_000 })).stdout.trim();
const mode = process.argv[2];
if (!["harvest", "epics"].includes(mode)) throw new Error("Usage: maintenance.mjs harvest|epics");
const state = JSON.parse(await readBounded(resolve(root, "issues/migration/state.json"), 100000));
if (state.authority !== "repository") throw new Error("Local issue maintenance requires repository authority");
const client = clientFromEnv(); const base = process.env.ISSUES_BASE_BRANCH || "develop";
if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,199}$/.test(base)) throw new Error("Invalid maintenance base branch");
const pending = await client.paginate(`/repos/${client.repository}/pulls?state=open&base=${encodeURIComponent(base)}&per_page=100`);
if (pending.some(pr => pr.head?.ref?.startsWith("issues/maintenance-"))) {
  console.log("Local issue maintenance is waiting for its existing pull request");
} else {
  if (await git(["status", "--porcelain"])) throw new Error("Issue maintenance requires a clean checkout");
  const dryRun = process.env.DRY_RUN !== "false";
  if (mode === "epics") console.log(JSON.stringify(await sweepLocalEpics(root, { dryRun, graceHours: Number(process.env.GRACE_HOURS || "1") })));
  else await exec(process.execPath, [resolve(root, ".github/scripts/review-followups/harvest.mjs")], { cwd: root, timeout: 600000, maxBuffer: 4_000_000, env: process.env }).then(result => { console.log(result.stdout); if (result.stderr) console.error(result.stderr); });
  if (!dryRun && await git(["status", "--porcelain", "--", "issues"])) {
    const branch = `issues/maintenance-${randomUUID()}`;
    await git(["switch", "-c", branch]);
    await git(["config", "user.name", "github-actions[bot]"]); await git(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
    await git(["add", "--", "issues"]); await git(["commit", "-m", `Maintain repository issues (${mode})`]);
    await git(["push", "origin", `HEAD:refs/heads/${branch}`]);
    const result = await client.request("POST", `/repos/${client.repository}/pulls`, { body: { title: `Maintain repository issues (${mode})`, head: branch, base, body: "Updates the repository issue ledger. Specifications remain proposed until explicitly approved. Review the issue and history changes before merging.", draft: false } });
    if (!result || !Number.isSafeInteger(result.number)) throw new Error("Maintenance PR creation returned an invalid identity");
    console.log(`Created issue maintenance PR #${result.number}`);
  }
}
