import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRecord, digest, serializeRecord } from "./records.mjs";
import { approveIssue, completeIssue } from "./store.mjs";

const body = "**Blocked by:** none\n\n## Context\nOne mechanism.\n\n## Task\nDeliver it.\n\n## Touches\n- example.txt\n\n## Scope\n### In scope\nThe mechanism.\n### Out of scope\nOther work.\n\n## Acceptance criteria\nThe mechanism works.\n";
const commit = "a".repeat(40);

async function fixture(t, issue) {
  const root = await mkdtemp(join(tmpdir(), "semprec-complete-")); t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ["items", "handovers"]) await mkdir(join(root, "issues", path), { recursive: true });
  const path = join(root, `issues/items/${issue.metadata.id}.md`);
  await writeFile(path, serializeRecord(issue));
  return { root, path, hash: digest(serializeRecord(issue)) };
}

test("completion closes an approved implementation, records its PR and writes the handover", async t => {
  const issue = approveIssue(createRecord({ title: "Deliver", body }), "maintainer");
  const { root, path, hash } = await fixture(t, issue);
  const closed = await completeIssue(root, issue.metadata.id, hash, { handover: "Delivered the mechanism.\n", pullRequest: 42, commit, at: "2026-10-30T10:00:00Z" });
  assert.equal(closed.metadata.state, "closed");
  assert.equal(closed.metadata.stateReason, "completed");
  assert.deepEqual(closed.metadata.resolution, { pullRequests: [42], commit, at: "2026-10-30T10:00:00Z" });
  assert.ok(!closed.metadata.labels.includes("agent:ready"));
  assert.match(await readFile(path, "utf8"), /^state: "closed"$/m);
  assert.equal(await readFile(join(root, `issues/handovers/${issue.metadata.id}.md`), "utf8"), "Delivered the mechanism.\n");
});

test("completion refuses a stale file hash and leaves the issue unchanged", async t => {
  const issue = approveIssue(createRecord({ title: "Deliver", body }), "maintainer");
  const { root, path } = await fixture(t, issue);
  const before = await readFile(path, "utf8");
  await assert.rejects(completeIssue(root, issue.metadata.id, "b".repeat(64), { handover: "Handover\n", pullRequest: 42, commit }), /reread before writing/);
  assert.equal(await readFile(path, "utf8"), before);
});

test("completion refuses an unapproved specification", async t => {
  const issue = createRecord({ title: "Proposal", body });
  const { root, hash } = await fixture(t, issue);
  await assert.rejects(completeIssue(root, issue.metadata.id, hash, { handover: "Handover\n", pullRequest: 42, commit }), /current approved open specification/);
});

test("completion refuses an issue that is already closed", async t => {
  const issue = approveIssue(createRecord({ title: "Deliver", body }), "maintainer");
  issue.metadata.state = "closed"; issue.metadata.stateReason = "completed"; issue.metadata.closedAt = "2026-10-29T10:00:00Z";
  const { root, hash } = await fixture(t, issue);
  await assert.rejects(completeIssue(root, issue.metadata.id, hash, { handover: "Handover\n", pullRequest: 42, commit }), /current approved open specification/);
});

test("completion requires a positive pull request number and a full implementation commit", async t => {
  const issue = approveIssue(createRecord({ title: "Deliver", body }), "maintainer");
  const { root, hash } = await fixture(t, issue);
  await assert.rejects(completeIssue(root, issue.metadata.id, hash, { handover: "Handover\n", pullRequest: 0, commit }), /pull request number/);
  await assert.rejects(completeIssue(root, issue.metadata.id, hash, { handover: "Handover\n", pullRequest: 42, commit: "short" }), /commit SHA/);
});

test("completion refuses an empty handover before touching the issue", async t => {
  const issue = approveIssue(createRecord({ title: "Deliver", body }), "maintainer");
  const { root, path, hash } = await fixture(t, issue);
  const before = await readFile(path, "utf8");
  await assert.rejects(completeIssue(root, issue.metadata.id, hash, { handover: "  \n", pullRequest: 42, commit }), /handover is required/);
  assert.equal(await readFile(path, "utf8"), before);
});
