import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRecord, digest, serializeRecord } from "./records.mjs";
import { approveIssue, completeIssue } from "./store.mjs";
import { verifyCompletion } from "./completion.mjs";
import { sweepLocalEpics } from "./epics.mjs";
import { localFollowups } from "./followups.mjs";

const body = "**Blocked by:** none\n**Model tier:** low\n\n## Context\nModel tier rationale: One mechanism.\n\n## Task\nDeliver it.\n\n## Touches\n- example.txt\n\n## Scope\n### In scope\nThe mechanism.\n### Out of scope\nOther work.\n\n## Acceptance criteria\nThe mechanism works.\n";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "semprec-local-lifecycle-")); t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ["items", "handovers", "migration"]) await mkdir(join(root, "issues", path), { recursive: true });
  await writeFile(join(root, "issues/migration/state.json"), JSON.stringify({ schemaVersion: 1, repository: "dvdtrsnk/semprec", authority: "repository" }));
  const save = issue => writeFile(join(root, `issues/items/${issue.metadata.id}.md`), serializeRecord(issue));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  return { root, save, git };
}

test("completion proves frozen approved bytes and handover while recording a valid original proposal", async t => {
  const { root, save, git } = await fixture(t);
  const issue = approveIssue(createRecord({ title: "Deliver", body }), "maintainer"); await save(issue);
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com"); git("add", "."); git("commit", "-qm", "Approved task");
  const revision = git("rev-parse", "HEAD"); const hash = digest(serializeRecord(issue));
  await assert.rejects(verifyCompletion(root, issue.metadata.id, revision, hash), /completion metadata/);
  await completeIssue(root, issue.metadata.id, hash, { handover: "Delivered and verified the mechanism.\n", commit: revision });
  assert.equal((await verifyCompletion(root, issue.metadata.id, revision, hash)).commit, revision);
  await assert.rejects(verifyCompletion(root, issue.metadata.id, revision, "a".repeat(64)), /dispatch/);
  const path = join(root, `issues/items/${issue.metadata.id}.md`);
  await writeFile(path, (await readFile(path, "utf8")) + "Changed task");
  await assert.rejects(verifyCompletion(root, issue.metadata.id, revision, hash), /approved specification/);
});

test("local follow-up ledger creates proposed canonical dependencies, parents and comments without a remote client", async t => {
  const { root } = await fixture(t); const api = await localFollowups({ issueRoot: root });
  const epic = await api.create({ title: "Follow-ups", body: "Container", labels: ["followups:issue"] });
  const first = await api.create({ title: "First", body, labels: ["spec:proposed", "followups:issue"] });
  const second = await api.create({ title: "Second", body: body.replace("none", `#${first.number}`), labels: ["spec:proposed", "followups:issue"] });
  assert.match((await api.get(second.number)).body, new RegExp(first.canonicalId));
  await api.child(epic.number, first.number);
  assert.equal((await api.list("spec:proposed", "open")).length, 2);
  await api.comment(epic.number, "Triage finished");
  assert.equal((await api.comments(epic.number))[0].body, "Triage finished");
  await api.removeLabel(first.number, "followups:issue");
  await api.close(first.number); assert.equal((await api.get(first.number)).state, "closed");
  await assert.rejects(api.get(999), /missing/);
  await assert.rejects(api.child(second.number, first.number), /epic/);
});

test("epic sweep waits, withdraws on changed work, honors opt-out and makes dry runs read-only", async t => {
  const { root, save } = await fixture(t);
  const epic = createRecord({ title: "Epic", kind: "epic", body: "Container" });
  const child = createRecord({ title: "Child", body, parent: epic.metadata.id });
  child.metadata.state = "closed"; child.metadata.stateReason = "not_planned"; child.metadata.closedAt = child.metadata.updatedAt;
  await save(epic); await save(child);
  const run = (dryRun, now) => sweepLocalEpics(root, { dryRun, now, graceHours: 1 });
  assert.deepEqual((await run(true, "2026-10-27T12:00:00Z")).announced, [epic.metadata.id]);
  assert.deepEqual((await run(false, "2026-10-27T12:00:00Z")).announced, [epic.metadata.id]);
  assert.deepEqual((await run(false, "2026-10-27T12:30:00Z")).waiting, [epic.metadata.id]);
  epic.metadata.labels.push("epic:wip"); await save(epic);
  assert.deepEqual((await run(false, "2026-10-27T14:00:00Z")).withdrawn, [epic.metadata.id]);
  epic.metadata.labels = []; await save(epic);
  await run(false, "2026-10-27T14:00:00Z");
  assert.deepEqual((await run(false, "2026-10-27T15:00:00Z")).closed, [epic.metadata.id]);
});

test("only unchanged imported records may retain their recorded historical diagnostics", async t => {
  const { validateCatalog } = await import("./validation.mjs");
  const { diagnoseCatalog } = await import("./records.mjs");
  const { root, save } = await fixture(t);
  const issue = createRecord({ title: "Historical", body: body.replace("**Model tier:** low\n", "") }); await save(issue);
  const catalog = new Map([[issue.metadata.id, issue]]);
  const diagnostics = diagnoseCatalog(catalog);
  await writeFile(join(root, "issues/migration/manifest.json"), JSON.stringify({ diagnostics, files: [{ path: `issues/items/${issue.metadata.id}.md`, sha256: digest(serializeRecord(issue)) }] }));
  assert.equal((await validateCatalog(root, catalog)).errors.length, 0);
  assert.equal((await validateCatalog(root, catalog)).historical.length, 1);
  issue.body += "Edited invalid specification";
  assert.equal((await validateCatalog(root, catalog)).errors.length, 1);
});

test("local issue comment routing keeps PR review conversations on their native endpoint", async t => {
  const { listIssueComments } = await import("../review-followups/github.mjs");
  const { root } = await fixture(t); const requests = [];
  const client = { issueRoot: root, repository: "dvdtrsnk/semprec", async paginate(path) { requests.push(path); return []; } };
  assert.deepEqual(await listIssueComments(client, 999, "pull-request"), []);
  assert.equal(requests.length, 1);
  await assert.rejects(listIssueComments(client, 999), /missing/);
  assert.equal(requests.length, 1);
});


test("every implementation PR revision retains completion even when a later edit keeps approval valid", async t => {
  const { checkPullRequestCompletion } = await import("./check-pr-completion.mjs");
  const { root, save, git } = await fixture(t);
  assert.deepEqual(await checkPullRequestCompletion(root, {}), { skipped: true });
  assert.deepEqual(await checkPullRequestCompletion(root, { pull_request: { body: "Maintenance" } }), { skipped: true });
  await assert.rejects(checkPullRequestCompletion(root, { pull_request: { body: "Repository-Issue: invalid" } }));
  const issue = approveIssue(createRecord({ title: "Deliver", body }), "maintainer"); await save(issue);
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com"); git("add", "."); git("commit", "-qm", "Approved task");
  const sha = git("rev-parse", "HEAD"); const event = { pull_request: { body: `Repository-Issue: ${issue.metadata.id}\n`, base: { sha } } };
  await completeIssue(root, issue.metadata.id, digest(serializeRecord(issue)), { handover: "Delivered the mechanism", commit: sha });
  assert.equal((await checkPullRequestCompletion(root, event)).completed, true);
  await save(issue); // A later fix pushed the still-valid original open metadata.
  await assert.rejects(checkPullRequestCompletion(root, event), /completion metadata/);
});
