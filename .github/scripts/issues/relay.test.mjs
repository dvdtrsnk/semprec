import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRecord, digest, relayIndex, relayNumber, serializeRecord } from "./records.mjs";
import { approveIssue, queueIssue } from "./store.mjs";
import { repositoryIssueRead } from "./relay.mjs";

const revision = "a".repeat(40);
const body = "**Blocked by:** none\n**Model tier:** low\n\n## Context\nModel tier rationale: One existing mechanism.\n\n## Task\nDeliver the mechanism.\n\n## Touches\n- example.txt\n\n## Scope\n### In scope\nThe mechanism.\n### Out of scope\nOther work.\n\n## Acceptance criteria\nThe mechanism returns the expected result.\n";
async function fixture(t, authority = "repository") {
  const root = await mkdtemp(join(tmpdir(), "semprec-relay-reader-")); t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ["items", "handovers", "migration"]) await mkdir(join(root, "issues", path), { recursive: true });
  await writeFile(join(root, "issues/migration/state.json"), JSON.stringify({ schemaVersion: 1, repository: "dvdtrsnk/semprec", authority }));
  const issue = queueIssue(approveIssue(createRecord({ title: "Implement mechanism", body }), "maintainer"));
  const path = join(root, `issues/items/${issue.metadata.id}.md`); await writeFile(path, serializeRecord(issue));
  return { root, issue, path };
}

test("Relay aliases preserve GitHub numbers and use a stable checked compatibility mapping", () => {
  assert.equal(relayNumber("gh-2035"), 2035);
  assert.equal(relayNumber("sp-00000000-0000-4000-8000-000000000001"), 1528904303);
  assert.throws(() => relayNumber("gh-2147483648"), /compatibility range/);
  assert.throws(() => relayNumber("../invalid"));
  const first = createRecord({ title: "First", body }); const second = createRecord({ title: "Second", body });
  first.metadata.id = "sp-00000000-0000-4000-8000-00000000e46e";
  second.metadata.id = "sp-00000000-0000-4000-8000-00000000e58b";
  assert.throws(() => relayIndex(new Map([[first.metadata.id, first], [second.metadata.id, second]])), /identity collision/);
});

test("repository protocol lists, reads and hashes the exact local approved specification", async t => {
  const env = await fixture(t);
  const rows = await repositoryIssueRead(env.root, { operation: "list", revision, label: "agent:ready", excludedLabel: "agent:blocked" });
  assert.equal(rows.length, 1); assert.equal(rows[0].body, body);
  assert.equal(rows[0].repositoryIssue.id, env.issue.metadata.id);
  assert.equal(rows[0].repositoryIssue.fileSha256, digest(await readFile(env.path, "utf8")));
  const number = relayNumber(env.issue.metadata.id);
  assert.deepEqual(await repositoryIssueRead(env.root, { operation: "get", revision, number }), rows[0]);
  const state = await repositoryIssueRead(env.root, { operation: "state", revision, number });
  assert.equal(state.open, true); assert.equal(state.delivered, false);
  assert.deepEqual(await repositoryIssueRead(env.root, { operation: "children", revision, number }), []);
});

test("inactive authority requires explicit shadow reading and never falls back to GitHub", async t => {
  const env = await fixture(t, "github");
  assert.deepEqual(await repositoryIssueRead(env.root, { operation: "capabilities" }), { version: 1, authority: "github" });
  await assert.rejects(repositoryIssueRead(env.root, { operation: "list", revision, label: "agent:ready" }), /not active/);
  assert.equal((await repositoryIssueRead(env.root, { operation: "list", revision, label: "agent:ready", allowShadow: true })).length, 1);
});

test("local reader refuses absent identities, unknown fields and malformed revisions", async t => {
  const env = await fixture(t);
  for (const request of [{ operation: "get", number: 42, revision }, { operation: "get", number: 1, revision: "invalid" }, { operation: "list", revision, label: "agent:ready", token: "untrusted" }, { operation: "delete", revision }])
    await assert.rejects(repositoryIssueRead(env.root, request));
});

test("stale approval cannot dispatch and a cancelled closed issue is not delivered", async t => {
  const env = await fixture(t);
  env.issue.body += "Changed scope"; await writeFile(env.path, serializeRecord(env.issue));
  assert.deepEqual(await repositoryIssueRead(env.root, { operation: "list", revision, label: "agent:ready" }), []);
  env.issue.metadata.state = "closed"; env.issue.metadata.stateReason = "not_planned"; env.issue.metadata.closedAt = new Date().toISOString();
  await writeFile(env.path, serializeRecord(env.issue));
  const state = await repositoryIssueRead(env.root, { operation: "state", revision, number: relayNumber(env.issue.metadata.id) });
  assert.equal(state.open, false); assert.equal(state.delivered, false);
});
