#!/usr/bin/env node
/** Validate Markdown issue bodies before publishing/arming; no GitHub writes. */
import { readFile, stat } from "node:fs/promises";
import { validateIssueModelMetadata } from "./model-tier.mjs";
if (process.argv.length < 3) { console.error("Usage: node .github/scripts/validate-issue-model-tier.mjs <issue-body.md> [...]"); process.exitCode = 1; }
for (const path of process.argv.slice(2)) {
  try {
    if ((await stat(path)).size > 240000) throw new Error("issue body exceeds maximum size");
    const parsed = validateIssueModelMetadata(await readFile(path, "utf8"));
    if (!parsed.ok) { console.error(`${path}: model tier ${parsed.error}`); process.exitCode = 1; }
    else console.log(`${path}: ${parsed.tier}`);
  } catch (e) { console.error(`${path}: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; }
}
