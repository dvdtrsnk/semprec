#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { isEntryScript } from "../is-entry-script.mjs";
import { digest, integer, object, readBounded, string } from "./records.mjs";
import { exportedFile } from "./import.mjs";
import { writeImportedFile } from "./store.mjs";

async function json(path) { return JSON.parse(await readBounded(path, 20_000_000)); }
function array(value, label) {
  if (!Array.isArray(value) || value.length > 100000) throw new Error(`Invalid ${label}`);
  return value;
}

export function attachmentUrls(texts) {
  const urls = new Set();
  for (const text of texts) {
    if (typeof text !== "string") continue;
    for (const match of text.matchAll(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)(?:\s+[^)]*)?\)/g)) urls.add(match[1]);
    for (const match of text.matchAll(/https:\/\/(?:user-images\.githubusercontent\.com\/|private-user-images\.githubusercontent\.com\/|github\.com\/user-attachments\/)[^\s<>"')\]]+/g)) urls.add(match[0]);
  }
  return [...urls].sort();
}

/** Cross-references point to current source issues; their full bodies are stored once in the issue catalog. */
export function normalizeTimelineReference(value) {
  const event = object(value, "timeline event");
  if (event.event !== "cross-referenced") return event;
  const source = object(event.source, "timeline source"); const issue = object(source.issue, "referenced issue");
  const reference = { id: integer(issue.id, "referenced id"), node_id: string(issue.node_id, "referenced node id", 200),
    number: integer(issue.number, "referenced issue number"), title: string(issue.title, "referenced title", 1000),
    html_url: string(issue.html_url, "referenced URL", 2048), repository_url: string(issue.repository_url, "referenced repository", 2048),
    state: string(issue.state, "referenced state", 100) };
  if (issue.pull_request !== undefined) reference.pull_request = object(issue.pull_request, "referenced PR");
  const hash = typeof issue.body === "string" ? digest(issue.body) : issue.bodySha256 ?? null;
  if (hash !== null && (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) throw new Error("Invalid referenced body checksum");
  return { ...event, source: { type: string(source.type, "timeline source type", 100), issue: { ...reference, bodySha256: hash } } };
}

export async function readExportListing(root) {
  const progress = object(await json(resolve(root, "progress.json")), "export progress");
  if (progress.complete !== true) throw new Error("Issue listing is incomplete");
  const pageCount = array(progress.pages, "page evidence").length;
  if (!pageCount || pageCount > 1000) throw new Error("Invalid issue page count");
  const issues = new Map();
  let offset = 0;
  for (let page = 1; page <= pageCount; page++) {
    const proof = object(progress.pages[page - 1], "page evidence");
    const perPage = proof.perPage ?? 10; const apiPage = proof.apiPage ?? page;
    if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100 || !Number.isInteger(apiPage) || (apiPage - 1) * perPage !== offset)
      throw new Error("Non-contiguous issue pagination");
    const values = array(await json(resolve(root, `raw/list/${page}.json`)), "issue page");
    if (values.length !== proof.count || values.length > perPage || page < pageCount && values.length !== perPage || page === pageCount && values.length === perPage)
      throw new Error("Issue listing lacks its terminal partial page");
    offset += values.length;
    for (const value of values) {
      const row = object(value, "issue");
      if (Object.hasOwn(row, "pull_request")) continue;
      const number = integer(row.number, "issue number");
      if (issues.has(number)) throw new Error("Duplicate source issue");
      issues.set(number, row);
    }
  }
  if (issues.size !== array(progress.issues, "listed issues").length) throw new Error("Issue listing count differs from checkpoint");
  return { issues, progress };
}

async function historyBatches(root, issues) {
  const result = new Map();
  let entries;
  try { entries = await readdir(resolve(root, "raw/history"), { withFileTypes: true }); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return result;
    throw error;
  }
  for (const entry of entries) {
    const match = /^(timeline|comments|children)-\d+\.json$/.exec(entry.name);
    if (!entry.isFile() || !match) throw new Error("Unexpected history batch");
    for (const value of array(await json(resolve(root, "raw/history", entry.name)), "history batch")) {
      const proof = object(value, "history proof"); integer(proof.number, "history issue number");
      const expected = match[1] === "children" ? "sub_issues" : match[1];
      const key = `${match[1]}:${proof.number}`;
      if (!issues.has(proof.number) || proof.collection !== expected || result.has(key)) throw new Error("Duplicate, foreign or mismatched history batch");
      result.set(key, proof);
    }
  }
  return result;
}

async function collection(root, kind, number, batches) {
  const directory = resolve(root, `raw/${kind}/${number}`);
  const batch = batches.get(`${kind}:${number}`);
  const proof = batch ? { ...batch, pages: array(batch.pages, "history pages").length } : object(await json(resolve(directory, "complete.json")), "collection proof");
  if (proof.complete !== true || !Number.isInteger(proof.pages) || proof.pages < 1 || proof.pages > 1000
    || !Number.isInteger(proof.perPage) || proof.perPage < 1 || proof.perPage > 100) throw new Error(`Incomplete ${kind} for #${number}`);
  const values = [];
  for (let page = 1; page <= proof.pages; page++) {
    const rows = array(batch ? batch.pages[page - 1] : await json(resolve(directory, `${page}.json`)), kind);
    if (rows.length > proof.perPage || page < proof.pages && rows.length !== proof.perPage || page === proof.pages && rows.length === proof.perPage)
      throw new Error(`Incomplete ${kind} pagination for #${number}`);
    values.push(...(kind === "timeline" ? rows.map(normalizeTimelineReference) : rows));
  }
  if (values.length !== proof.count) throw new Error(`Wrong ${kind} count for #${number}`);
  return values;
}

export async function assembleExport(root, destination, exportedAt) {
  const { issues, progress } = await readExportListing(root);
  const batches = await historyBatches(root, issues);
  const closings = new Map();
  const closingDirectory = resolve(root, "raw/closing");
  for (const entry of await readdir(closingDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^\d+\.json$/.test(entry.name)) throw new Error("Unexpected closing-reference entry");
    for (const value of array(await json(resolve(closingDirectory, entry.name)), "closing references")) {
      const row = object(value, "closing references"); const number = integer(row.issueNumber, "closing issue number");
      if (!issues.has(number) || closings.has(number)) throw new Error("Duplicate or foreign closing reference");
      closings.set(number, array(row.closedByPullRequests, "closing PRs"));
    }
  }
  if (closings.size !== issues.size) throw new Error("Closing reference export is incomplete");
  const files = [];
  const assets = new Map();
  for (const [number, issue] of issues) {
    const comments = issue.comments === 0 ? [] : await collection(root, "comments", number, batches);
    const children = object(issue.sub_issues_summary, "sub-issue summary").total === 0 ? [] : await collection(root, "children", number, batches);
    const events = await collection(root, "timeline", number, batches);
    if (comments.length !== issue.comments || children.length !== issue.sub_issues_summary.total) throw new Error(`Changed collection count for #${number}`);
    const closedByPullRequests = closings.get(number);
    const urls = attachmentUrls([issue.body, ...comments.map(value => object(value, "comment").body), ...closedByPullRequests.map(value => object(value, "closing PR").body)]);
    const attachments = urls.length ? array(await json(resolve(root, `raw/assets/${number}.json`)), "asset coverage") : [];
    if (attachments.length !== urls.length || urls.some(url => !attachments.some(value => object(value, "asset").url === url)))
      throw new Error(`Incomplete attachment coverage for #${number}`);
    for (const attachment of attachments) {
      if (attachment.status === "downloaded") {
        const bytes = await exportedFile(root, attachment.path, attachment.sha256, 64_000_000, true);
        const previous = assets.get(attachment.path);
        if (previous && digest(previous) !== attachment.sha256) throw new Error("Conflicting attachment export paths");
        assets.set(attachment.path, bytes);
      } else if (attachment.status !== "unavailable") throw new Error("Invalid attachment export status");
    }
    const coverage = { comments, events, subIssues: children, closedByPullRequests };
    const bundle = { issue, ...coverage, attachments, collections: Object.fromEntries(Object.entries(coverage).map(([key, rows]) => [key, { complete: true, count: rows.length }])) };
    const content = JSON.stringify(bundle);
    files.push({ number, path: `issues/${number}.json`, sha256: digest(content), content });
  }
  const openCount = [...issues.values()].filter(issue => issue.state === "open").length;
  const manifest = { schemaVersion: 1, repository: "dvdtrsnk/semprec", state: "all", complete: true, exportedAt,
    issueCount: issues.size, openCount, closedCount: issues.size - openCount,
    sourcePagination: progress.pages,
    issues: files.map(({ number, path, sha256 }) => ({ number, path, sha256 })) };
  // Validate the complete cache before publishing any assembled bundle.
  for (const [path, bytes] of assets) await writeImportedFile(resolve(destination, path), bytes);
  for (const file of files) await writeImportedFile(resolve(destination, file.path), file.content);
  await writeImportedFile(resolve(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (isEntryScript(import.meta.url)) {
  const [root, destination, exportedAt] = process.argv.slice(2);
  if (!root || !destination || !exportedAt) { console.error("Usage: assemble-export.mjs <cache-directory> <export-directory> <exported-at>"); process.exitCode = 1; }
  else assembleExport(resolve(root), resolve(destination), exportedAt).then(manifest => console.log(JSON.stringify({ issues: manifest.issueCount, open: manifest.openCount, closed: manifest.closedCount }))).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
