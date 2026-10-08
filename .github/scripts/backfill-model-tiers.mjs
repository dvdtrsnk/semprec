#!/usr/bin/env node
/** Guarded, resumable issue metadata migration. Dry run is the default. */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile, rename, mkdtemp, rm, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseIssueModelTier, validateIssueModelMetadata } from "./model-tier.mjs";

const run = promisify(execFile);
export const bodyHash = body => createHash("sha256").update(body).digest("hex");
const tiers = ["low", "medium", "high"];
const repoPattern = /^[\w.-]+\/[\w.-]+$/;

export function renderMetadata(body, tier, rationale) {
  if (typeof body !== "string" || body.length > 60000 || !tiers.includes(tier) || typeof rationale !== "string" || !rationale.trim() || /[\r\n]/.test(rationale)) throw new Error("Invalid metadata assessment");
  const existing = parseIssueModelTier(body);
  if (existing.ok) {
    if (existing.tier !== tier || !validateIssueModelMetadata(body).ok) throw new Error("Existing metadata needs explicit reassessment; refusing to overwrite it");
    return body;
  }
  if (existing.error !== "missing") throw new Error(`Existing header is ${existing.error}; repair it explicitly before backfill`);
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(newline);
  if (!/^\*\*Blocked by:\*\* (?:none|#\d+(?:, #\d+)*)\s*$/.test(lines[0])) throw new Error("Issue must retain its canonical first-line Blocked by header");
  lines.splice(1, 0, `**Model tier:** ${tier}`);
  const context = lines.findIndex(line => line.trimEnd() === "## Context");
  if (context < 0) throw new Error("Issue has no Context section");
  lines.splice(context + 1, 0, "", `Model tier rationale: ${rationale.trim()}`);
  const rendered = lines.join(newline);
  if (!validateIssueModelMetadata(rendered).ok || rendered.length > 60000) throw new Error("Rendered issue metadata is invalid or too large");
  return rendered;
}

export function prepareManifest(assessment, issues) {
  if (assessment?.version !== 1 || !repoPattern.test(assessment.repo) || !Array.isArray(assessment.assessments) || !Array.isArray(issues)) throw new Error("Invalid assessment or issue snapshot");
  const byNumber = new Map(issues.map(issue => [issue.number, issue]));
  if (byNumber.size !== issues.length) throw new Error("Duplicate issues in snapshot");
  const entries = assessment.assessments.map(item => {
    const issue = byNumber.get(item.number);
    if (!issue || typeof issue.body !== "string" || bodyHash(issue.body) !== item.sourceBodySha256) throw new Error(`Issue #${item.number} changed since assessment`);
    const excluded = item.kind !== "implementation";
    const afterBody = excluded ? issue.body : renderMetadata(issue.body, item.modelTier, item.rationale);
    return { number: item.number, kind: item.kind, modelTier: item.modelTier, rationale: item.rationale,
      beforeBody: issue.body, beforeBodySha256: bodyHash(issue.body), afterBody, afterBodySha256: bodyHash(afterBody), sourceUpdatedAt: issue.updatedAt };
  });
  if (entries.length !== issues.length) throw new Error("Assessment must account for every open issue");
  const manifest = { version: 1, repo: assessment.repo, preparedAt: new Date().toISOString(), entries };
  validateManifest(manifest);
  return manifest;
}

export function validateManifest(manifest) {
  if (manifest?.version !== 1 || typeof manifest.repo !== "string" || !repoPattern.test(manifest.repo) || !Array.isArray(manifest.entries) || manifest.entries.length > 1000) throw new Error("Invalid manifest");
  const seen = new Set();
  for (const entry of manifest.entries) {
    if (!Number.isSafeInteger(entry?.number) || entry.number < 1 || seen.has(entry.number)) throw new Error("Invalid or duplicate manifest issue number");
    seen.add(entry.number);
    if (typeof entry.beforeBody !== "string" || typeof entry.afterBody !== "string" || entry.beforeBody.length > 60000 || entry.afterBody.length > 60000 || bodyHash(entry.beforeBody) !== entry.beforeBodySha256 || bodyHash(entry.afterBody) !== entry.afterBodySha256) throw new Error(`Invalid body/hash for #${entry.number}`);
    if (!["implementation", "epic", "manual"].includes(entry.kind)) throw new Error(`Invalid issue kind for #${entry.number}`);
    if (entry.kind === "implementation") {
      const parsed = validateIssueModelMetadata(entry.afterBody);
      if (!parsed.ok || parsed.tier !== entry.modelTier) throw new Error(`Invalid target metadata for #${entry.number}`);
    } else if (entry.beforeBody !== entry.afterBody) throw new Error("Exempt issue must remain unchanged");
  }
}

/** GitHub lacks an issue-body compare-and-swap API: re-read immediately before PATCH,
 * verify afterward, and stop on an unexpected result. Never retry an unknown write. */
export async function migrateEntry(entry, api, mode, ledger, saveLedger) {
  if (entry.beforeBody === entry.afterBody) return "unchanged";
  const current = await api.read(entry.number);
  if (mode !== "rollback" && current.state === "closed") return "closed";
  const currentHash = bodyHash(current.body);
  const sourceHash = mode === "rollback" ? entry.afterBodySha256 : entry.beforeBodySha256;
  const targetHash = mode === "rollback" ? entry.beforeBodySha256 : entry.afterBodySha256;
  const targetBody = mode === "rollback" ? entry.beforeBody : entry.afterBody;
  const state = mode === "rollback" ? "rolled-back" : "applied";
  if (currentHash === targetHash) {
    if (mode === "rollback" && !["applied", "applying", "rolling-back", "rolled-back"].includes(ledger[entry.number])) return "not-applied";
    if (mode === "apply" && !["applied", "applying", "rolling-back"].includes(ledger[entry.number])) return "already-target";
    if (mode !== "dry-run") { ledger[entry.number] = state; await saveLedger(); }
    return "already-target";
  }
  if (currentHash !== sourceHash) return "conflict";
  if (mode === "dry-run") return "would-change";
  if (mode === "rollback" && !["applied", "applying", "rolling-back"].includes(ledger[entry.number])) return "not-applied";
  ledger[entry.number] = mode === "rollback" ? "rolling-back" : "applying";
  await saveLedger();
  await api.write(entry.number, targetBody);
  const verified = await api.read(entry.number);
  if (bodyHash(verified.body) !== targetHash) throw new Error(`Issue #${entry.number} changed during write; inspect it before continuing`);
  ledger[entry.number] = state;
  await saveLedger();
  return state;
}

async function readJson(path) {
  if ((await stat(path)).size > 20 * 1024 * 1024) throw new Error("Input JSON exceeds the size limit");
  const content = await readFile(path, "utf8");
  if (Buffer.byteLength(content) > 20 * 1024 * 1024) throw new Error("Input JSON exceeds the size limit");
  return JSON.parse(content);
}
async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}
function gitHubApi(repo) {
  const call = async argv => {
    const { stdout } = await run("gh", ["api", ...argv], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(stdout);
  };
  return {
    read: async number => {
      const issue = await call([`repos/${repo}/issues/${number}`]);
      if (!issue || issue.number !== number || typeof issue.body !== "string" || !["open", "closed"].includes(issue.state) || issue.pull_request) throw new Error(`Invalid issue response for #${number}`);
      return issue;
    },
    write: async (number, body) => {
      const directory = await mkdtemp(join(tmpdir(), "relay-tier-body-"));
      try {
        const path = join(directory, "request.json");
        await writeFile(path, JSON.stringify({ body }), { mode: 0o600 });
        await call([`repos/${repo}/issues/${number}`, "--method", "PATCH", "--input", path]);
      } finally {
        try { await rm(directory, { recursive: true, force: true }); }
        catch (error) { console.error(`Temporary request cleanup failed: ${error instanceof Error ? error.message : String(error)}`); }
      }
    },
  };
}

async function main(argv) {
  const options = new Map();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!["--prepare", "--apply", "--rollback", "--manifest", "--assessment", "--issues", "--ledger"].includes(key) || options.has(key)) throw new Error(`Unknown or repeated option: ${key}`);
    if (["--prepare", "--apply", "--rollback"].includes(key)) options.set(key, true);
    else { const value = argv[++i]; if (!value || value.startsWith("--")) throw new Error(`Missing ${key} value`); options.set(key, value); }
  }
  const manifestPath = options.get("--manifest");
  if (!manifestPath || ["--prepare", "--apply", "--rollback"].filter(key => options.has(key)).length > 1) throw new Error("Use --manifest <file> with at most one of --prepare, --apply, --rollback; default is a dry run");
  if (options.has("--prepare")) {
    if (!options.get("--assessment") || !options.get("--issues")) throw new Error("Preparation requires --assessment and --issues");
    const manifest = prepareManifest(await readJson(options.get("--assessment")), await readJson(options.get("--issues")));
    await atomicJson(manifestPath, manifest);
    console.log(`Prepared ${manifest.entries.length} issues for ${manifest.repo}`);
    return;
  }
  const manifest = await readJson(manifestPath);
  validateManifest(manifest);
  const mode = options.has("--rollback") ? "rollback" : options.has("--apply") ? "apply" : "dry-run";
  const ledgerPath = options.get("--ledger") ?? `${manifestPath}.ledger.json`;
  let ledgerRecord = { version: 1, manifestSha256: bodyHash(JSON.stringify(manifest)), entries: {} };
  try { ledgerRecord = await readJson(ledgerPath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (ledgerRecord?.version !== 1 || ledgerRecord.manifestSha256 !== bodyHash(JSON.stringify(manifest)) || !ledgerRecord.entries || typeof ledgerRecord.entries !== "object" || Array.isArray(ledgerRecord.entries)) throw new Error("Ledger does not belong to this manifest");
  const api = gitHubApi(manifest.repo);
  let conflicts = 0;
  for (const entry of manifest.entries) {
    const status = await migrateEntry(entry, api, mode, ledgerRecord.entries, () => atomicJson(ledgerPath, ledgerRecord));
    console.log(`#${entry.number}: ${status}`);
    if (status === "conflict") conflicts++;
  }
  if (conflicts) throw new Error(`${conflicts} issue conflicts; nothing was overwritten on those issues`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
