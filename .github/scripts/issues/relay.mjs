#!/usr/bin/env node
import { resolve } from "node:path";
import { isEntryScript } from "../is-entry-script.mjs";
import { dependencyComplete, digest, identifier, integer, loadCatalog, object, readBounded, readyIssues, relayIndex, relayNumber, string } from "./records.mjs";
import { handoverIds } from "./store.mjs";

/** Credential-free host protocol. The host supplies a verified checkout revision. */
export async function repositoryIssueRead(root, input) {
  const request = object(input, "repository issue request");
  if (!["capabilities", "list", "get", "state", "children"].includes(request.operation)) throw new Error("Unsupported repository issue read");
  if (Object.keys(request).some(key => !["operation", "number", "label", "excludedLabel", "revision", "allowShadow"].includes(key))) throw new Error("Unknown repository issue request field");
  const migration = object(JSON.parse(await readBounded(resolve(root, "issues/migration/state.json"), 100000)), "migration state");
  if (migration.schemaVersion !== 1 || migration.repository !== "dvdtrsnk/semprec" || !["github", "repository"].includes(migration.authority)) throw new Error("Invalid repository issue authority");
  if (request.operation === "capabilities") return { version: 1, authority: migration.authority };
  if (request.allowShadow !== undefined && typeof request.allowShadow !== "boolean") throw new Error("Invalid shadow flag");
  if (migration.authority !== "repository" && request.allowShadow !== true) throw new Error("Repository issue authority is not active");
  const revision = string(request.revision, "checkout revision", 40);
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Invalid verified checkout revision");
  const catalog = await loadCatalog(root); const index = relayIndex(catalog);
  const handovers = await handoverIds(root);
  const represent = async issue => {
    const id = identifier(issue.metadata.id);
    const fileSha256 = digest(await readBounded(resolve(root, `issues/items/${id}.md`)));
    return { repositoryIssueKind: issue.metadata.kind, number: relayNumber(id), title: issue.metadata.title, body: issue.body, labels: issue.metadata.labels, open: issue.metadata.state === "open",
      url: `https://github.com/dvdtrsnk/semprec/blob/${revision}/issues/items/${id}.md`,
      repositoryIssue: { id, revision, fileSha256, bodySha256: digest(issue.body) } };
  };
  if (request.operation === "list") {
    const label = string(request.label, "trigger label", 255); const excluded = string(request.excludedLabel ?? "", "excluded label", 255);
    const candidates = label === "agent:ready" ? readyIssues(catalog, handovers) : [...catalog.values()].filter(issue => issue.metadata.state === "open");
    const selected = candidates.filter(issue => issue.metadata.labels.includes(label) && !issue.metadata.labels.includes(excluded));
    return Promise.all(selected.map(represent));
  }
  const number = integer(request.number, "Relay issue number");
  const issue = index.get(number);
  if (!issue) throw new Error(`LOCAL_ISSUE_MISSING: ${number}`);
  if (request.operation === "get") return represent(issue);
  if (request.operation === "children") return Promise.all([...catalog.values()].filter(value => value.metadata.parent === issue.metadata.id).map(represent));
  const children = [...catalog.values()].filter(value => value.metadata.parent === issue.metadata.id);
  return { open: issue.metadata.state === "open", labels: issue.metadata.labels, delivered: dependencyComplete(issue, handovers),
    subIssuesSummary: { total: children.length, completed: children.filter(value => value.metadata.state === "closed").length } };
}

if (isEntryScript(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || process.argv[2].length > 10000) throw new Error("Usage: relay.mjs '<bounded-json-request>'");
    const result = await repositoryIssueRead(process.cwd(), JSON.parse(process.argv[2]));
    const output = JSON.stringify(result);
    if (Buffer.byteLength(output) > 4_000_000) throw new Error("Repository issue result exceeds the host protocol limit");
    console.log(output);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
