#!/usr/bin/env node
import { resolve } from "node:path";
import { isEntryScript } from "./is-entry-script.mjs";
import { createRecord, diagnoseCatalog, digest, identifier, loadCatalog, readBounded, readyIssues, serializeRecord } from "./issues/records.mjs";
import { approveIssue, blockIssue, handoverIds, mutateIssue, queueIssue, reopenIssue, writeExclusive } from "./issues/store.mjs";
import { importExport } from "./issues/import.mjs";

export async function main(args = process.argv.slice(2), root = process.cwd(), output = console.log) {
  const [command, ...rest] = args;
  if (!["list", "show", "ready", "validate", "create", "approve", "queue", "block", "reopen", "import"].includes(command))
    throw new Error("Usage: node .github/scripts/issues.mjs list|show|ready|validate|create|approve|queue|block|reopen|import [arguments]");
  if (command === "import") {
    if (rest.length < 1 || rest.length > 2 || rest.length === 2 && rest[1] !== "--dry-run") throw new Error("import <export-directory> [--dry-run]");
    output(JSON.stringify(await importExport(resolve(root, rest[0]), root, { dryRun: rest[1] === "--dry-run" }), null, 2));
    return;
  }
  if (command === "create") {
    if (rest.length < 2 || rest.length % 2 !== 0) throw new Error("create <title> <body.md> [--kind implementation|epic|harvest|checkpoint] [--parent <id>]");
    const options = {};
    for (let i = 2; i < rest.length; i += 2) {
      const key = rest[i] === "--kind" ? "kind" : rest[i] === "--parent" ? "parent" : null;
      if (!key || Object.hasOwn(options, key)) throw new Error("Unknown or duplicate create option");
      options[key] = rest[i + 1];
    }
    const issue = createRecord({ title: rest[0], body: await readBounded(resolve(root, rest[1])), ...options });
    await writeExclusive(resolve(root, `issues/items/${issue.metadata.id}.md`), serializeRecord(issue));
    output(issue.metadata.id);
    return;
  }
  const catalog = await loadCatalog(root);
  if (["list", "ready", "validate"].includes(command)) {
    if (rest.length) throw new Error(`${command} takes no arguments`);
    if (command === "validate") {
      const diagnostics = diagnoseCatalog(catalog);
      output(JSON.stringify({ count: catalog.size, diagnostics }, null, 2));
      if (diagnostics.length) throw new Error(`Issue validation found ${diagnostics.length} diagnostic(s)`);
    } else {
      const issues = command === "ready" ? readyIssues(catalog, await handoverIds(root)) : [...catalog.values()];
      output(JSON.stringify(issues.map(issue => ({ id: issue.metadata.id, title: issue.metadata.title, kind: issue.metadata.kind, state: issue.metadata.state, labels: issue.metadata.labels })), null, 2));
    }
    return;
  }
  const id = identifier(rest[0]);
  const issue = catalog.get(id);
  if (!issue) throw new Error(`Issue not found: ${id}`);
  if (command === "show") {
    if (rest.length !== 1) throw new Error("show <id>");
    output(JSON.stringify({ ...issue, fileSha256: digest(await readBounded(resolve(root, `issues/items/${id}.md`))) }, null, 2));
    return;
  }
  if (rest.length !== (command === "approve" ? 3 : 2)) throw new Error(`${command} <id> <expected-file-sha256>${command === "approve" ? " <actor>" : ""}`);
  const mutations = { approve: value => approveIssue(value, rest[2]), queue: queueIssue, block: blockIssue, reopen: reopenIssue };
  await mutateIssue(root, id, rest[1], mutations[command]);
  output(id);
}

if (isEntryScript(import.meta.url)) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
