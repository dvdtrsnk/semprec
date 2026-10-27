import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { object, string, integer, record, digest, specDigest, serializeRecord, diagnoseCatalog, readBounded } from "./records.mjs";
import { writeImportedFile } from "./store.mjs";

const REPOSITORY = "dvdtrsnk/semprec";

function array(value, label, max = 100000) {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label}: expected bounded array`);
  return value;
}

function iso(value, label) {
  string(value, label, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${label}: invalid timestamp`);
  return value;
}

function names(value, label) {
  return array(value, label, 1000).map(entry => typeof entry === "string" ? string(entry, label, 1000) : string(object(entry, label).name, label, 1000));
}

export function convertIssue(rawValue, importedAt, { parent = null, hasChildren = false } = {}) {
  const raw = object(rawValue, "GitHub issue");
  if (Object.hasOwn(raw, "pull_request")) throw new Error("PR returned as issue");
  const number = integer(raw.number, "issue.number");
  const labels = names(raw.labels, "issue.labels");
  const body = raw.body === null ? "" : string(raw.body, "issue.body", 1_000_000);
  const kind = labels.includes("followups:harvest") ? "harvest" : hasChildren || /(?:—|–|-)\s*epic\s*$/i.test(raw.title) ? "epic"
    : /\*\*Model tier:\*\*/.test(body.split(/^## /m)[0]) || /^## Task\s*$/m.test(body) ? "implementation" : "checkpoint";
  const issue = record({ schemaVersion: 1, id: `gh-${number}`, title: raw.title, kind, state: raw.state,
    stateReason: raw.state_reason ?? null, labels, parent,
    assignees: array(raw.assignees, "assignees", 1000).map(value => string(object(value, "assignee").login, "assignee login", 200)),
    milestone: raw.milestone === null ? null : { number: integer(object(raw.milestone, "milestone").number, "milestone.number"), title: string(raw.milestone.title, "milestone.title", 1000) },
    createdAt: raw.created_at, updatedAt: raw.updated_at, closedAt: raw.closed_at,
    source: { system: "github", repository: REPOSITORY, number, id: raw.id, nodeId: raw.node_id,
      url: raw.html_url, bodySha256: digest(body), importedAt }, approval: null, resolution: null }, body);
  if (labels.includes("spec:approved") && kind === "implementation") {
    issue.metadata.approval = { specSha256: specDigest(issue), source: "github-label", actor: null, at: importedAt };
  }
  return issue;
}

export async function exportedFile(exportRoot, path, sha256, maxBytes = 20_000_000, binary = false) {
  string(path, "export path", 2000);
  if (isAbsolute(path) || path.split(/[\\/]/).some(part => part === ".." || part === "")) throw new Error("Unsafe export path");
  const base = await realpath(exportRoot);
  const candidate = await realpath(resolve(base, path));
  const rel = relative(base, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Export path escapes root");
  const info = await lstat(candidate);
  if (!info.isFile() || info.size > maxBytes) throw new Error("Export file exceeds maximum size or is not regular");
  const bytes = await readFile(candidate);
  if (bytes.length > maxBytes || !/^[a-f0-9]{64}$/.test(string(sha256, "export checksum", 64)) || digest(bytes) !== sha256) throw new Error(`Export checksum mismatch: ${path}`);
  if (binary) return bytes;
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw new Error("Export JSON is not valid UTF-8");
  return text;
}

function commentFiles(id, values) {
  const seen = new Set();
  return array(values, "comments").map(value => {
    const comment = object(value, "comment");
    integer(comment.id, "comment.id");
    if (seen.has(comment.id)) throw new Error("Duplicate comment id");
    seen.add(comment.id);
    const author = comment.user === null ? null : string(object(comment.user, "comment author").login, "comment author", 200);
    const metadata = { id: comment.id, author, createdAt: iso(comment.created_at, "comment.created_at"), updatedAt: iso(comment.updated_at, "comment.updated_at"), url: string(comment.html_url, "comment url", 2000) };
    return { path: `issues/history/${id}/comments/${comment.id}.md`, content: `---\n${Object.entries(metadata).map(([key, item]) => `${key}: ${JSON.stringify(item)}`).join("\n")}\n---\n${string(comment.body, "comment body", 1_000_000)}` };
  });
}

/** Import only complete, checksum-verified exports. GitHub access belongs to the scoped exporter. */
export async function prepareImport(exportRoot) {
  const manifest = object(JSON.parse(await readBounded(resolve(exportRoot, "manifest.json"), 20_000_000)), "export manifest");
  if (manifest.schemaVersion !== 1 || manifest.repository !== REPOSITORY || manifest.state !== "all" || manifest.complete !== true)
    throw new Error("Expected complete all-state Semprec export");
  iso(manifest.exportedAt, "exportedAt");
  const files = array(manifest.issues, "export issues");
  if (!Number.isSafeInteger(manifest.issueCount) || manifest.issueCount !== files.length || files.length === 0) throw new Error("Export issue count mismatch or empty export");
  if (manifest.openCount + manifest.closedCount !== manifest.issueCount) throw new Error("Export state counts disagree");
  const bundles = new Map();
  let totalBytes = 0;
  for (const value of files) {
    const file = object(value, "export entry");
    integer(file.number, "export number");
    const text = await exportedFile(exportRoot, file.path, file.sha256);
    totalBytes += Buffer.byteLength(text);
    if (totalBytes > 200_000_000) throw new Error("Export exceeds import memory budget");
    const bundle = object(JSON.parse(text), "issue export");
    const raw = object(bundle.issue, "exported issue");
    if (raw.number !== file.number || bundles.has(raw.number)) throw new Error("Export duplicate or identity mismatch");
    for (const collection of ["comments", "events", "subIssues", "closedByPullRequests"]) {
      const proof = object(object(bundle.collections, "collection coverage")[collection], collection);
      const entries = array(bundle[collection], collection);
      if (proof.complete !== true || proof.count !== entries.length) throw new Error(`Incomplete ${collection} for #${file.number}`);
    }
    if (bundle.comments.length !== raw.comments || bundle.subIssues.length !== object(raw.sub_issues_summary, "sub issue summary").total)
      throw new Error(`GitHub collection count mismatch for #${file.number}`);
    bundles.set(raw.number, bundle);
  }
  const parents = new Map();
  for (const [number, bundle] of bundles) for (const childValue of bundle.subIssues) {
    const child = integer(object(childValue, "sub issue").number, "sub issue number");
    if (!bundles.has(child) || parents.has(child)) throw new Error(`Missing child or duplicate parent for #${child}`);
    parents.set(child, number);
  }
  const output = [];
  const catalog = new Map();
  let openCount = 0;
  const unavailableAttachments = [];
  for (const [number, bundle] of bundles) {
    const parent = parents.get(number);
    if ((bundle.issue.parent_issue_url ?? null) !== (parent ? `https://api.github.com/repos/${REPOSITORY}/issues/${parent}` : null))
      throw new Error(`Parent relationship mismatch for #${number}`);
    const issue = convertIssue(bundle.issue, manifest.exportedAt, { parent: parent ? `gh-${parent}` : null, hasChildren: bundle.subIssues.length > 0 });
    if (issue.metadata.state === "open") openCount++;
    catalog.set(issue.metadata.id, issue);
    const id = issue.metadata.id;
    output.push({ path: `issues/items/${id}.md`, content: serializeRecord(issue) });
    output.push(...commentFiles(id, bundle.comments));
    output.push({ path: `issues/history/${id}/events.json`, content: `${JSON.stringify(bundle.events, null, 2)}\n` });
    output.push({ path: `issues/history/${id}/source.json`, content: `${JSON.stringify(bundle.issue, null, 2)}\n` });
    if (bundle.closedByPullRequests.length) {
      const sections = bundle.closedByPullRequests.map(value => {
        const pr = object(value, "closing PR");
        integer(pr.number, "closing PR number");
        if (pr.merged_at === null || !/^[a-f0-9]{40,64}$/.test(string(pr.merge_commit_sha, "merge commit", 64))) throw new Error("Closing PR is not a verified merge");
        iso(pr.merged_at, "merged_at");
        return `## PR #${pr.number}\n\nSource: https://github.com/${REPOSITORY}/pull/${pr.number}\n\nMerge commit: ${pr.merge_commit_sha}\n\n${string(pr.body ?? "", "closing PR body", 1_000_000)}`;
      });
      output.push({ path: `issues/handovers/${id}.md`, content: `# Handover for ${id}\n\n${sections.join("\n\n")}\n` });
    }
    for (const value of array(bundle.attachments, "attachments")) {
      const attachment = object(value, "attachment");
      string(attachment.url, "attachment URL", 10000);
      if (attachment.status === "unavailable") {
        unavailableAttachments.push({ issue: id, url: attachment.url, reason: string(attachment.reason, "attachment reason", 1000) });
      } else if (attachment.status === "downloaded") {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(string(attachment.filename, "attachment filename", 200))) throw new Error("Unsafe attachment filename");
        const bytes = await exportedFile(exportRoot, attachment.path, attachment.sha256, 64_000_000, true);
        totalBytes += bytes.length;
        if (totalBytes > 200_000_000) throw new Error("Export exceeds import memory budget");
        output.push({ path: `issues/attachments/${id}/${attachment.filename}`, content: bytes });
      } else throw new Error("Unknown attachment status");
    }
  }
  if (manifest.openCount !== openCount || manifest.closedCount !== catalog.size - openCount) throw new Error("Export open/closed totals mismatch");
  if (new Set(output.map(file => file.path)).size !== output.length) throw new Error("Duplicate import destination path");
  const diagnostics = diagnoseCatalog(catalog);
  const report = { schemaVersion: 1, repository: REPOSITORY, exportedAt: manifest.exportedAt, issueCount: catalog.size,
    openCount, closedCount: catalog.size - openCount, diagnostics, unavailableAttachments,
    files: output.map(file => ({ path: file.path, sha256: digest(file.content) })) };
  output.push({ path: "issues/migration/manifest.json", content: `${JSON.stringify(report, null, 2)}\n` });
  return { files: output, report };
}

export async function importExport(exportRoot, root, { dryRun = false } = {}) {
  const prepared = await prepareImport(exportRoot);
  if (!dryRun) for (const file of prepared.files) await writeImportedFile(resolve(root, file.path), file.content);
  return prepared.report;
}
