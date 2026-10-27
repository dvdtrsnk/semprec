import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { blockers, createRecord, diagnoseCatalog, digest, identifier, loadCatalog, parseRecord, readyIssues, serializeRecord, specDigest, validateMetadata, validateSpecification } from "./records.mjs";
import { approveIssue, blockIssue, handoverIds, mutateIssue, queueIssue, reopenIssue, writeImportedFile } from "./store.mjs";
import { main } from "../issues.mjs";

const now = "2026-10-27T12:00:00.000Z";
export const body = "**Blocked by:** none\n**Model tier:** medium\n\n## Context\nModel tier rationale: One existing mechanism.\n\n## Task\nImplement the operation.\n\n## Touches\n- backend/packages/data/src/example.ts\n\n## Scope\n### In scope\nThe operation.\n### Out of scope\nOther operations.\n\n## Acceptance criteria\nThe operation returns the specified result.\n";
export function issue() { return createRecord({ title: "Implement operation", body, now }); }
function approved() { return queueIssue(approveIssue(issue(), "maintainer", now), now); }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "semprec-issues-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "issues/items"), { recursive: true });
  await mkdir(join(root, "issues/handovers"), { recursive: true });
  return root;
}

test("frontmatter roundtrip preserves Markdown bytes including CRLF, unicode and delimiter lines", () => {
  const value = issue(); value.body += "\r\n---\r\nPříloha 😀\r\n";
  assert.deepEqual(parseRecord(serializeRecord(value)), value);
});
test("frontmatter refuses malformed, duplicate, unknown and implicit-YAML fields", () => {
  const text = serializeRecord(issue());
  for (const bad of ["no header", text.replace("schemaVersion: 1", "schemaVersion: 2"), text.replace("schemaVersion: 1", "schemaVersion: 1\nschemaVersion: 1"), text.replace("schemaVersion: 1", "unknown: 1"), text.replace('state: "open"', "state: open")]) assert.throws(() => parseRecord(bad));
});
test("ids reject traversal, unsafe integers, zero and invalid UUIDs", () => {
  for (const id of ["../foo", "gh-0", "gh-9007199254740992", "gh-01", "sp-nope", null]) assert.throws(() => identifier(id));
  assert.equal(identifier("gh-2035"), "gh-2035");
  assert.equal(identifier(issue().metadata.id).slice(0, 3), "sp-");
});
test("metadata rejects missing fields, bad dates, foreign source and contradictory closure", () => {
  for (const change of [meta => delete meta.labels, meta => meta.createdAt = "yesterday", meta => meta.state = "closed", meta => meta.kind = "unknown", meta => meta.parent = meta.id, meta => meta.source = { system: "github", repository: "other/repo" }]) {
    const value = issue(); change(value.metadata); assert.throws(() => validateMetadata(value.metadata));
  }
});
test("implementation specification requires ordered unique sections, scope and canonical model metadata", () => {
  assert.doesNotThrow(() => validateSpecification(issue()));
  for (const text of [body.replace("## Task", "## Tasks"), body.replace("### Out of scope", "### Later"), body.replace("**Model tier:** medium", "**Model tier:** unknown"), body.replace("## Task", "## Context\n## Task"), body.replace("**Blocked by:** none", "Blocked later"), body.replace("## Context", "## Task").replace("## Task\nImplement", "## Context\nImplement")]) {
    const value = issue(); value.body = text; assert.throws(() => validateSpecification(value));
  }
});
test("blockers support historical numbers and local ids but reject ambiguous grammar", () => {
  const value = issue(); const local = issue().metadata.id;
  value.body = body.replace("none", `#42, ${local}`);
  assert.deepEqual(blockers(value), ["gh-42", local]);
  for (const deps of ["#42 #43", "#42, #42", "none, #42", "#0", "#42 (later)"]) {
    value.body = body.replace("none", deps); assert.throws(() => blockers(value));
  }
});
test("ready requires approval, queue intent, valid specification and open state", () => {
  const value = approved(); const catalog = new Map([[value.metadata.id, value]]);
  assert.deepEqual(readyIssues(catalog), [value]);
  for (const change of [v => v.metadata.labels = [], v => v.metadata.approval = null, v => v.metadata.labels.push("spec:proposed"), v => v.metadata.state = "closed", v => v.metadata.kind = "epic", v => v.body = "bad"]) {
    const changed = structuredClone(value); change(changed);
    assert.deepEqual(readyIssues(new Map([[changed.metadata.id, changed]])), []);
  }
});
for (const label of ["agent:blocked", "agent:needs-human-action", "relay:needs-human-action"]) test(`ready respects park label ${label}`, () => {
  const value = approved(); value.metadata.labels.push(label);
  assert.deepEqual(readyIssues(new Map([[value.metadata.id, value]])), []);
});
test("title, parent and body changes invalidate approval; unrelated runtime label does not", () => {
  const value = approved(); const original = specDigest(value);
  for (const change of [v => v.body += "Changed scope", v => v.metadata.title += " changed", v => v.metadata.parent = issue().metadata.id]) {
    const changed = structuredClone(value); change(changed);
    assert.notEqual(specDigest(changed), original);
    assert.ok(diagnoseCatalog(new Map([[changed.metadata.id, changed]])).some(item => item.message === "Approval is stale"));
    assert.deepEqual(readyIssues(new Map([[changed.metadata.id, changed]])), []);
  }
  value.metadata.labels.push("custom:label"); assert.equal(specDigest(value), original);
});
test("missing, cancelled and completed-without-handover dependencies fail closed", () => {
  const parent = approved(); const child = issue();
  child.body = body.replace("none", parent.metadata.id); approveIssue(child, "maintainer", now); queueIssue(child, now);
  const catalog = new Map([[parent.metadata.id, parent], [child.metadata.id, child]]);
  assert.ok(!readyIssues(catalog).includes(child));
  catalog.delete(parent.metadata.id); assert.deepEqual(readyIssues(catalog), []);
  catalog.set(parent.metadata.id, parent); parent.metadata.state = "closed"; parent.metadata.stateReason = "not_planned";
  assert.deepEqual(readyIssues(catalog, new Set([parent.metadata.id])), []);
  parent.metadata.stateReason = "completed";
  assert.deepEqual(readyIssues(catalog), []);
  assert.deepEqual(readyIssues(catalog, new Set([parent.metadata.id])), [child]);
});
test("dependency cycles, epic blockers, missing parents and hierarchy cycles are diagnosed", () => {
  const first = issue(); const second = issue();
  first.body = body.replace("none", second.metadata.id); second.body = body.replace("none", first.metadata.id);
  const catalog = new Map([[first.metadata.id, first], [second.metadata.id, second]]);
  assert.ok(diagnoseCatalog(catalog).some(item => item.message === "Dependency cycle"));
  first.metadata.kind = "epic"; second.metadata.parent = first.metadata.id; first.metadata.parent = second.metadata.id;
  const messages = diagnoseCatalog(catalog).map(item => item.message);
  assert.ok(messages.some(message => message.startsWith("Epic cannot")));
  assert.ok(messages.includes("Parent cycle"));
  assert.ok(messages.some(message => message.startsWith("Parent is not epic")));
  catalog.delete(first.metadata.id);
  assert.ok(diagnoseCatalog(catalog).some(item => item.message.startsWith("Missing parent")));
});
test("approval never queues implicitly and refuses closed, malformed or non-implementation work", () => {
  const value = approveIssue(issue(), "maintainer", now);
  assert.ok(value.metadata.labels.includes("spec:approved")); assert.ok(!value.metadata.labels.includes("agent:ready"));
  assert.equal(value.metadata.approval.specSha256, specDigest(value));
  for (const change of [v => v.metadata.state = "closed", v => v.metadata.kind = "epic", v => v.body = "invalid"]) {
    const bad = issue(); change(bad); assert.throws(() => approveIssue(bad, "maintainer", now));
  }
  assert.throws(() => approveIssue(issue(), "", now));
});
test("queue refuses unapproved, stale and protected-path work", () => {
  assert.throws(() => queueIssue(issue(), now));
  const stale = approveIssue(issue(), "maintainer", now); stale.body += "changed";
  assert.throws(() => queueIssue(stale, now));
  for (const path of [".relay/workflows/example.md", ".github/workflows/ci.yml", ".github/scripts/check-protected-paths.mjs", ".github/scripts/review-bot-disabled.mjs"]) {
    const value = issue(); value.body = body.replace("backend/packages/data/src/example.ts", path);
    approveIssue(value, "maintainer", now); assert.throws(() => queueIssue(value, now), /Protected-path/);
  }
});
test("block and reopen preserve specification but reopening clears queue and resolution", () => {
  const value = approved(); const hash = specDigest(value);
  blockIssue(value, now); assert.ok(value.metadata.labels.includes("agent:blocked"));
  assert.equal(specDigest(value), hash);
  assert.throws(() => reopenIssue(value));
  value.metadata.state = "closed"; value.metadata.stateReason = "completed"; value.metadata.closedAt = now;
  assert.throws(() => blockIssue(value));
  reopenIssue(value, now);
  assert.equal(value.metadata.state, "open"); assert.equal(value.metadata.closedAt, null); assert.equal(value.metadata.resolution, null);
  assert.ok(!value.metadata.labels.includes("agent:ready"));
});
test("filesystem catalog detects id mismatch, unexpected entries and symlinks", async t => {
  const root = await fixture(t); const value = issue();
  const path = join(root, `issues/items/${value.metadata.id}.md`);
  await writeFile(path, serializeRecord(value));
  assert.equal((await loadCatalog(root)).size, 1);
  await writeFile(join(root, "issues/items/gh-1.md"), serializeRecord(value));
  await assert.rejects(loadCatalog(root), /mismatch/);
  await rm(join(root, "issues/items/gh-1.md"));
  await symlink(path, join(root, "issues/items/gh-1.md"));
  await assert.rejects(loadCatalog(root), /Unexpected/);
});
test("concurrent CLI writers cannot overwrite one another and stale writes leave file unchanged", { timeout: 5000 }, async t => {
  const root = await fixture(t); const value = issue(); const text = serializeRecord(value);
  const path = join(root, `issues/items/${value.metadata.id}.md`); await writeFile(path, text);
  let entered; const started = new Promise(resolve => { entered = resolve; });
  let release; const gate = new Promise(resolve => { release = resolve; });
  const writer = mutateIssue(root, value.metadata.id, digest(text), async current => { entered(); await gate; return approveIssue(current, "maintainer", now); });
  await started;
  await assert.rejects(mutateIssue(root, value.metadata.id, digest(text), current => blockIssue(current)), { code: "EEXIST" });
  release(); await writer;
  const approvedText = await readFile(path, "utf8");
  await assert.rejects(mutateIssue(root, value.metadata.id, digest(text), current => blockIssue(current)), /changed/);
  assert.equal(await readFile(path, "utf8"), approvedText);
});
test("failed mutation releases reservation without changing content", async t => {
  const root = await fixture(t); const value = issue(); const text = serializeRecord(value);
  const path = join(root, `issues/items/${value.metadata.id}.md`); await writeFile(path, text);
  await assert.rejects(mutateIssue(root, value.metadata.id, digest(text), () => { throw new Error("refused"); }), /refused/);
  assert.equal(await readFile(path, "utf8"), text);
  await mutateIssue(root, value.metadata.id, digest(text), current => blockIssue(current, now));
  assert.ok(parseRecord(await readFile(path, "utf8")).metadata.labels.includes("agent:blocked"));
});
test("import replay accepts identical files but refuses local edits", async t => {
  const root = await fixture(t); const path = join(root, "issues/history/gh-1/comments/1.md");
  await writeImportedFile(path, "original"); await writeImportedFile(path, "original");
  await writeFile(path, "local edit"); await assert.rejects(writeImportedFile(path, "original"), /conflicts/);
  assert.equal(await readFile(path, "utf8"), "local edit");
});
test("CLI create/show/list/approve/queue/ready use the production store without network", async t => {
  const root = await fixture(t); await writeFile(join(root, "body.md"), body);
  const logs = []; const out = value => logs.push(value);
  await main(["create", "Implement operation", "body.md"], root, out);
  const id = logs.at(-1); assert.ok(id.startsWith("sp-"));
  await main(["show", id], root, out); const shown = JSON.parse(logs.at(-1));
  assert.equal(shown.body, body);
  await main(["approve", id, shown.fileSha256, "maintainer"], root, out);
  await main(["show", id], root, out); const approvedShown = JSON.parse(logs.at(-1));
  await main(["queue", id, approvedShown.fileSha256], root, out);
  await main(["ready"], root, out); assert.equal(JSON.parse(logs.at(-1))[0].id, id);
  await main(["validate"], root, out); assert.equal(JSON.parse(logs.at(-1)).count, 1);
  await main(["list"], root, out); assert.equal(JSON.parse(logs.at(-1)).length, 1);
  await assert.rejects(main(["show", "gh-1"], root, out), /not found/);
  await assert.rejects(main(["list", "unexpected"], root, out));
});

test("CLI creates unqueued epics with parent relationships and rejects invalid options", async t => {
  const root = await fixture(t); await writeFile(join(root, "epic.md"), "## Context\nApproved behavior\n");
  const logs = []; const output = value => logs.push(value);
  await main(["create", "Batch — epic", "epic.md", "--kind", "epic"], root, output);
  const epicId = logs.at(-1);
  await writeFile(join(root, "child.md"), body);
  await main(["create", "Child", "child.md", "--parent", epicId], root, output);
  const catalog = await loadCatalog(root);
  assert.equal(catalog.get(epicId).metadata.kind, "epic");
  assert.equal(catalog.get(logs.at(-1)).metadata.parent, epicId);
  assert.deepEqual(readyIssues(catalog), []);
  for (const args of [["--kind", "unknown"], ["--unknown", "x"], ["--kind", "epic", "--kind", "epic"], ["--parent", "../bad"]])
    await assert.rejects(main(["create", "Invalid", "epic.md", ...args], root, output));
  assert.equal((await loadCatalog(root)).size, 2);
});

test("existing model-tier CLI validates raw bodies and repository envelopes", async t => {
  const root = await fixture(t); const value = issue();
  const rawPath = join(root, "body.md"); const wrappedPath = join(root, "record.md");
  await writeFile(rawPath, body); await writeFile(wrappedPath, serializeRecord(value));
  const cli = fileURLToPath(new URL("../validate-issue-model-tier.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [cli, rawPath, wrappedPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.match(/: medium/g)?.length, 2);
  value.body = value.body.replace("**Model tier:** medium", "**Model tier:** invalid");
  await writeFile(wrappedPath, serializeRecord(value));
  const invalid = spawnSync(process.execPath, [cli, wrappedPath], { encoding: "utf8" });
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /model tier/);
});

test("checked-in JSON schema covers exactly the serialized metadata fields", async () => {
  const schema = JSON.parse(await readFile(new URL("../../../issues/schema.json", import.meta.url), "utf8"));
  assert.deepEqual(new Set(schema.required), new Set(Object.keys(issue().metadata)));
  assert.deepEqual(new Set(Object.keys(schema.properties)), new Set(schema.required));
  assert.equal(schema.additionalProperties, false);
});

test("handover discovery rejects empty and unexpected files and reads valid local context", async t => {
  const root = await fixture(t);
  assert.equal((await handoverIds(root)).size, 0);
  const path = join(root, "issues/handovers/gh-1.md");
  await writeFile(path, ""); await assert.rejects(handoverIds(root), /Empty handover/);
  await writeFile(path, "# Handover\nDelivered context\n");
  assert.deepEqual(await handoverIds(root), new Set(["gh-1"]));
  await writeFile(join(root, "issues/handovers/unexpected.txt"), "x");
  await assert.rejects(handoverIds(root), /Unexpected/);
});
