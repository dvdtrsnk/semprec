import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { validateIssueModelMetadata } from "../model-tier.mjs";

export const ID_PATTERN = /^(?:gh-[1-9]\d*|sp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
export const BODY_LIMIT = 1_000_000;
const FILE_LIMIT = BODY_LIMIT + 100_000;
const KINDS = ["implementation", "epic", "harvest", "checkpoint"];
const STATES = ["open", "closed"];
const KEYS = ["schemaVersion", "id", "title", "kind", "state", "stateReason", "labels", "parent", "assignees", "milestone", "createdAt", "updatedAt", "closedAt", "source", "approval", "resolution"];

export function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: expected object`);
  return value;
}

export function string(value, label, max = 10000) {
  if (typeof value !== "string" || value.length > max) throw new Error(`${label}: expected bounded string`);
  return value;
}

export function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label}: expected positive safe integer`);
  return value;
}

export function identifier(value) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new Error("Invalid issue id");
  if (value.startsWith("gh-")) integer(Number(value.slice(3)), "GitHub issue number");
  return value;
}

/** Numeric compatibility for Relay; the Markdown id remains the canonical identity. */
export function relayNumber(id) {
  identifier(id);
  const value = id.startsWith("gh-") ? Number(id.slice(3)) : 1_000_000_000 + Number.parseInt(digest(id).slice(0, 8), 16) % 1_000_000_000;
  if (value > 2_147_483_647) throw new Error("Issue identity exceeds Relay's numeric compatibility range");
  return value;
}

export function relayIndex(catalog) {
  const result = new Map();
  for (const [id, issue] of catalog) {
    const number = relayNumber(id);
    if (result.has(number)) throw new Error(`Relay identity collision between ${result.get(number).metadata.id} and ${id}`);
    result.set(number, issue);
  }
  return result;
}

export function digest(text) { return createHash("sha256").update(text).digest("hex"); }

function strings(value, label) {
  if (!Array.isArray(value) || value.length > 1000) throw new Error(`${label}: expected bounded array`);
  const result = value.map(item => string(item, label, 1000));
  if (new Set(result).size !== result.length) throw new Error(`${label}: duplicates`);
  return result;
}

function timestamp(value, label) {
  string(value, label, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new Error(`${label}: expected UTC timestamp`);
}

function exactKeys(value, keys, label) {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error(`${label}: unexpected field`);
}

export function validateMetadata(value) {
  const meta = object(value, "issue metadata");
  exactKeys(meta, KEYS, "issue metadata");
  if (meta.schemaVersion !== 1) throw new Error("Unsupported issue schema version");
  identifier(meta.id);
  if (!string(meta.title, "title", 1000).trim()) throw new Error("Empty issue title");
  if (!KINDS.includes(meta.kind)) throw new Error("Invalid issue kind");
  if (!STATES.includes(meta.state)) throw new Error("Invalid issue state");
  if (![null, "completed", "not_planned", "duplicate", "reopened"].includes(meta.stateReason)) throw new Error("Invalid state reason");
  strings(meta.labels, "labels");
  strings(meta.assignees, "assignees");
  if (meta.parent !== null) identifier(meta.parent);
  if (meta.parent === meta.id) throw new Error("Issue is its own parent");
  if (meta.milestone !== null) {
    const milestone = object(meta.milestone, "milestone");
    exactKeys(milestone, ["number", "title"], "milestone");
    integer(milestone.number, "milestone.number");
    string(milestone.title, "milestone.title", 1000);
  }
  timestamp(meta.createdAt, "createdAt");
  timestamp(meta.updatedAt, "updatedAt");
  if (meta.closedAt !== null) timestamp(meta.closedAt, "closedAt");
  if ((meta.state === "closed") !== (meta.closedAt !== null)) throw new Error("State and closedAt disagree");
  if (meta.source !== null) {
    const source = object(meta.source, "source");
    exactKeys(source, ["system", "repository", "number", "id", "nodeId", "url", "bodySha256", "importedAt"], "source");
    if (source.system !== "github" || source.repository !== "dvdtrsnk/semprec") throw new Error("Unexpected source repository");
    integer(source.number, "source.number");
    integer(source.id, "source.id");
    string(source.nodeId, "source.nodeId", 200);
    if (meta.id !== `gh-${source.number}` || source.url !== `https://github.com/${source.repository}/issues/${source.number}`)
      throw new Error("Source identity mismatch");
    if (!/^[a-f0-9]{64}$/.test(string(source.bodySha256, "source.bodySha256", 64))) throw new Error("Invalid source checksum");
    timestamp(source.importedAt, "source.importedAt");
  } else if (meta.id.startsWith("gh-")) throw new Error("Imported id requires provenance");
  if (meta.approval !== null) {
    const approval = object(meta.approval, "approval");
    exactKeys(approval, ["specSha256", "source", "actor", "at"], "approval");
    if (!/^[a-f0-9]{64}$/.test(string(approval.specSha256, "approval.specSha256", 64)) || !["github-label", "repository"].includes(approval.source)) throw new Error("Invalid approval");
    if (approval.actor !== null) string(approval.actor, "approval.actor", 200);
    timestamp(approval.at, "approval.at");
    if (approval.source === "github-label" && meta.source === null) throw new Error("GitHub approval requires imported provenance");
  }
  if (meta.resolution !== null) {
    const resolution = object(meta.resolution, "resolution");
    exactKeys(resolution, ["pullRequests", "commit", "at"], "resolution");
    if (!Array.isArray(resolution.pullRequests) || resolution.pullRequests.length > 100) throw new Error("Invalid resolution PRs");
    resolution.pullRequests.forEach(number => integer(number, "resolution PR"));
    if (!/^[a-f0-9]{40,64}$/.test(string(resolution.commit, "resolution.commit", 64))) throw new Error("Invalid implementation commit");
    timestamp(resolution.at, "resolution.at");
    if (meta.state !== "closed" || meta.stateReason !== "completed") throw new Error("Resolution requires completed state");
  }
  return meta;
}

/** Values use JSON syntax, a deliberately small YAML subset without aliases or implicit coercion. */
export function parseRecord(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > FILE_LIMIT) throw new Error("Issue file exceeds maximum size");
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error("Missing issue frontmatter (LF required)");
  const metadata = {};
  for (const line of match[1].split("\n")) {
    const field = /^([a-zA-Z][a-zA-Z0-9]*): (.+)$/.exec(line);
    if (!field || !KEYS.includes(field[1]) || Object.hasOwn(metadata, field[1])) throw new Error("Invalid or duplicate frontmatter field");
    metadata[field[1]] = JSON.parse(field[2]);
  }
  return record(metadata, text.slice(match[0].length));
}

export function record(metadata, body) {
  validateMetadata(metadata);
  string(body, "issue body", BODY_LIMIT);
  return { metadata, body };
}

export function serializeRecord(issue) {
  record(issue.metadata, issue.body);
  return `---\n${KEYS.map(key => `${key}: ${JSON.stringify(issue.metadata[key])}`).join("\n")}\n---\n${issue.body}`;
}

export function specDigest(issue) {
  return digest(JSON.stringify({ title: issue.metadata.title, kind: issue.metadata.kind, parent: issue.metadata.parent, body: issue.body }));
}

export function createRecord({ title, body, kind = "implementation", parent = null, now = new Date().toISOString() }) {
  return record({ schemaVersion: 1, id: `sp-${randomUUID()}`, title, kind, state: "open", stateReason: null,
    labels: ["spec:proposed"], parent, assignees: [], milestone: null, createdAt: now, updatedAt: now, closedAt: null,
    source: null, approval: null, resolution: null }, body);
}

export async function readBounded(path, limit = FILE_LIMIT) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > limit) throw new Error(`Not a bounded regular file: ${path}`);
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text) > limit) throw new Error(`File grew beyond limit: ${path}`);
  return text;
}

export async function loadCatalog(root) {
  const directory = resolve(root, "issues/items");
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > 100000) throw new Error("Issue catalog exceeds maximum size");
  const catalog = new Map();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === ".gitkeep") continue;
    if (!entry.isFile() || !entry.name.endsWith(".md")) throw new Error(`Unexpected issue entry: ${entry.name}`);
    const issue = parseRecord(await readBounded(resolve(directory, entry.name)));
    if (entry.name !== `${issue.metadata.id}.md`) throw new Error(`Issue id/filename mismatch: ${entry.name}`);
    if (catalog.has(issue.metadata.id)) throw new Error("Duplicate issue id");
    catalog.set(issue.metadata.id, issue);
  }
  return catalog;
}

export function blockers(issue) {
  const first = issue.body.split(/\r?\n/, 1)[0];
  const match = /^\*\*Blocked by:\*\* (.+?)\s*$/.exec(first);
  if (!match) throw new Error("Missing physical first-line Blocked by metadata");
  if (match[1] === "none") return [];
  const ids = match[1].split(",").map(value => {
    const trimmed = value.trim();
    return identifier(/^#[1-9]\d*$/.test(trimmed) ? `gh-${trimmed.slice(1)}` : trimmed);
  });
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate blockers");
  return ids;
}

export function validateSpecification(issue) {
  if (issue.metadata.kind !== "implementation") return;
  const tier = validateIssueModelMetadata(issue.body);
  if (!tier.ok) throw new Error(`Model tier: ${tier.error}`);
  const sections = ["Context", "Task", "Touches", "Scope", "Acceptance criteria"];
  let previous = -1;
  for (const section of sections) {
    const matches = [...issue.body.matchAll(new RegExp(`^## ${section}\\s*$`, "gm"))];
    if (matches.length !== 1 || matches[0].index <= previous) throw new Error(`Missing, duplicated or unordered section: ${section}`);
    previous = matches[0].index;
  }
  for (const scope of ["In scope", "Out of scope"])
    if (!new RegExp(`^### ${scope}\\s*$`, "m").test(issue.body)) throw new Error(`Missing ${scope}`);
  blockers(issue);
}

export function touchesProtectedPaths(issue) {
  const touches = issue.body.split(/^## Touches\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  return /\.relay\/|\.github\/workflows\/|\.github\/scripts\/(?:(?:check-protected-paths|review-bot-disabled|issues)\.mjs|issues\/)/.test(touches);
}

/** Imported completed dependencies need an exported handover before they unblock new work. */
export function dependencyComplete(issue, handovers) {
  return issue !== undefined && issue.metadata.state === "closed" && issue.metadata.stateReason === "completed" && handovers.has(issue.metadata.id);
}

export function diagnoseCatalog(catalog) {
  const diagnostics = [];
  const edges = new Map();
  for (const [id, issue] of catalog) {
    const add = message => diagnostics.push({ id, message });
    if (issue.metadata.kind !== "implementation" && issue.metadata.labels.includes("agent:ready")) add("Only implementation issues can be ready");
    if (issue.metadata.labels.includes("spec:approved") && issue.metadata.labels.includes("spec:proposed")) add("Conflicting spec labels");
    if (issue.metadata.labels.includes("spec:approved") && !issue.metadata.approval) add("Approved label lacks approval provenance");
    if (issue.metadata.labels.includes("agent:ready") && touchesProtectedPaths(issue)) add("Protected-path work cannot be queued");
    if (issue.metadata.parent !== null) {
      const parent = catalog.get(issue.metadata.parent);
      if (!parent) add(`Missing parent ${issue.metadata.parent}`);
      else if (parent.metadata.kind !== "epic") add(`Parent is not epic: ${issue.metadata.parent}`);
    }
    if (issue.metadata.approval && issue.metadata.approval.specSha256 !== specDigest(issue)) add("Approval is stale");
    try {
      validateSpecification(issue);
      const deps = issue.metadata.kind === "implementation" ? blockers(issue) : [];
      edges.set(id, deps);
      for (const dependency of deps) {
        if (!catalog.has(dependency)) add(`Missing dependency ${dependency}`);
        else if (catalog.get(dependency).metadata.kind === "epic") add(`Epic cannot be a blocker: ${dependency}`);
      }
    } catch (error) { add(error instanceof Error ? error.message : String(error)); }
  }
  function cycles(graph, label) {
    const active = new Set(); const done = new Set();
    for (const id of graph.keys()) {
      if (done.has(id)) continue;
      const pending = [{ id, exit: false }];
      while (pending.length) {
        const current = pending.pop();
        if (current.exit) { active.delete(current.id); done.add(current.id); continue; }
        if (active.has(current.id)) { diagnostics.push({ id: current.id, message: `${label} cycle` }); continue; }
        if (done.has(current.id)) continue;
        active.add(current.id);
        pending.push({ id: current.id, exit: true });
        for (const next of graph.get(current.id) ?? []) if (graph.has(next)) pending.push({ id: next, exit: false });
      }
    }
  }
  cycles(edges, "Dependency");
  cycles(new Map([...catalog].map(([id, issue]) => [id, issue.metadata.parent ? [issue.metadata.parent] : []])), "Parent");
  return diagnostics;
}

export function readyIssues(catalog, handovers = new Set()) {
  const invalid = new Set(diagnoseCatalog(catalog).map(diagnostic => diagnostic.id));
  return [...catalog.values()].filter(issue => {
    const meta = issue.metadata;
    return !invalid.has(meta.id) && meta.kind === "implementation" && meta.state === "open"
      && meta.labels.includes("spec:approved") && meta.labels.includes("agent:ready")
      && !meta.labels.some(label => ["agent:blocked", "agent:needs-human-action", "relay:needs-human-action"].includes(label))
      && meta.approval?.specSha256 === specDigest(issue)
      && blockers(issue).every(id => dependencyComplete(catalog.get(id), handovers));
  });
}
