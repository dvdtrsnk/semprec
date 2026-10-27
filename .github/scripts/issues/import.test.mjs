import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertIssue, exportedFile, importExport, prepareImport } from "./import.mjs";
import { digest, parseRecord, specDigest } from "./records.mjs";

const now = "2026-10-27T12:00:00Z";
const body = "**Blocked by:** none\n**Model tier:** low\n\n## Context\nModel tier rationale: A mechanical operation.\n\n## Task\nDo the operation.\n\n## Touches\n- example.txt\n\n## Scope\n### In scope\nThe operation.\n### Out of scope\nOther work.\n\n## Acceptance criteria\nIt works.\n";
function raw(number = 1) {
  return { number, id: number + 10000000000, node_id: `I_${number}`, title: "Implement operation", html_url: `https://github.com/dvdtrsnk/semprec/issues/${number}`,
    body, state: "open", state_reason: null, labels: [{ name: "spec:approved" }, { name: "agent:ready" }], assignees: [{ login: "owner" }], milestone: null,
    created_at: now, updated_at: now, closed_at: null, comments: 0, sub_issues_summary: { total: 0, completed: 0 }, parent_issue_url: null };
}
function bundle(number = 1) {
  return { issue: raw(number), comments: [], events: [], subIssues: [], closedByPullRequests: [], attachments: [],
    collections: Object.fromEntries(["comments", "events", "subIssues", "closedByPullRequests"].map(name => [name, { count: 0, complete: true }])) };
}
async function fixture(t, bundles = [bundle()]) {
  const root = await mkdtemp(join(tmpdir(), "semprec-import-")); t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, "export"); const destination = join(root, "repository");
  await mkdir(join(input, "issues"), { recursive: true });
  const manifest = { schemaVersion: 1, repository: "dvdtrsnk/semprec", state: "all", complete: true, exportedAt: now,
    issueCount: bundles.length, openCount: bundles.filter(value => value.issue.state === "open").length,
    closedCount: bundles.filter(value => value.issue.state === "closed").length, issues: [] };
  for (const value of bundles) {
    const content = JSON.stringify(value); const path = `issues/${value.issue.number}.json`;
    manifest.issues.push({ number: value.issue.number, path, sha256: digest(content) });
    await writeFile(join(input, path), content);
  }
  await writeFile(join(input, "manifest.json"), JSON.stringify(manifest));
  return { root, input, destination, manifest };
}

test("conversion preserves body bytes, source identity and labels without fabricating approval actor", () => {
  const original = raw(); original.body += "\r\nUnicode \u010d text 😀\r\n";
  const issue = convertIssue(original, now);
  assert.equal(issue.body, original.body);
  assert.equal(issue.metadata.source.bodySha256, digest(original.body));
  assert.equal(issue.metadata.approval.actor, null);
  assert.equal(issue.metadata.approval.source, "github-label");
  assert.equal(issue.metadata.approval.specSha256, specDigest(issue));
  assert.deepEqual(issue.metadata.assignees, ["owner"]);
});
test("conversion distinguishes epics, harvest, checkpoints and implementation without rewriting source", () => {
  const source = raw(); source.labels = []; source.body = null;
  assert.equal(convertIssue(source, now).metadata.kind, "checkpoint");
  source.title = "[batch] Feature — epic";
  assert.equal(convertIssue(source, now).metadata.kind, "epic");
  source.labels = [{ name: "followups:harvest" }];
  assert.equal(convertIssue(source, now).metadata.kind, "harvest");
  source.labels = []; source.title = "Batch";
  assert.equal(convertIssue(source, now, { hasChildren: true }).metadata.kind, "epic");
});
test("conversion refuses PRs and mismatched or foreign issue identities", () => {
  for (const change of [value => value.pull_request = {}, value => value.html_url = "https://github.com/other/repo/issues/1", value => value.id = 9007199254740992, value => value.state = "unknown"]) {
    const source = raw(); change(source); assert.throws(() => convertIssue(source, now));
  }
});
test("dry-run validates a complete export without writing destination; import is replayable", async t => {
  const setup = await fixture(t);
  const report = await importExport(setup.input, setup.destination, { dryRun: true });
  assert.equal(report.issueCount, 1); assert.deepEqual(report.diagnostics, []);
  await assert.rejects(readFile(join(setup.destination, "issues/items/gh-1.md")), { code: "ENOENT" });
  await importExport(setup.input, setup.destination); await importExport(setup.input, setup.destination);
  const value = parseRecord(await readFile(join(setup.destination, "issues/items/gh-1.md"), "utf8"));
  assert.equal(value.body, body);
  assert.deepEqual(JSON.parse(await readFile(join(setup.destination, "issues/migration/manifest.json"), "utf8")), report);
});
test("comments, events, source metadata, hierarchy and merged PR handovers survive import", async t => {
  const epic = bundle(1); epic.issue.title = "Batch — epic"; epic.issue.labels = []; epic.issue.body = "Approved behavior";
  const child = bundle(2); child.issue.parent_issue_url = "https://api.github.com/repos/dvdtrsnk/semprec/issues/1";
  epic.subIssues = [{ number: 2 }]; epic.collections.subIssues.count = 1; epic.issue.sub_issues_summary.total = 1;
  child.comments = [{ id: 99, user: null, created_at: now, updated_at: now, html_url: "https://github.com/dvdtrsnk/semprec/issues/2#issuecomment-99", body: "Original\r\ncomment 😀" }];
  child.collections.comments.count = 1; child.issue.comments = 1;
  child.events = [{ id: 77, event: "labeled", actor: { login: "owner" } }]; child.collections.events.count = 1;
  child.issue.state = "closed"; child.issue.state_reason = "completed"; child.issue.closed_at = now;
  child.closedByPullRequests = [{ number: 10, body: "Delivered mechanism\n\nFollow-up context", merged_at: now, merge_commit_sha: "a".repeat(40) }];
  child.collections.closedByPullRequests.count = 1;
  const setup = await fixture(t, [epic, child]); await importExport(setup.input, setup.destination);
  const converted = parseRecord(await readFile(join(setup.destination, "issues/items/gh-2.md"), "utf8"));
  assert.equal(converted.metadata.parent, "gh-1");
  assert.ok((await readFile(join(setup.destination, "issues/history/gh-2/comments/99.md"), "utf8")).endsWith(child.comments[0].body));
  assert.deepEqual(JSON.parse(await readFile(join(setup.destination, "issues/history/gh-2/events.json"), "utf8")), child.events);
  assert.match(await readFile(join(setup.destination, "issues/handovers/gh-2.md"), "utf8"), /Follow-up context/);
});
for (const collection of ["comments", "events", "subIssues", "closedByPullRequests"]) test(`incomplete ${collection} prevents every import write`, async t => {
  const value = bundle(); value.collections[collection].complete = false;
  const setup = await fixture(t, [value]);
  await assert.rejects(importExport(setup.input, setup.destination), /Incomplete/);
  await assert.rejects(readFile(join(setup.destination, "issues/items/gh-1.md")), { code: "ENOENT" });
});
test("incorrect hashes, all-state scope and manifest counts are refused", async t => {
  const setup = await fixture(t);
  for (const change of [value => value.complete = false, value => value.state = "open", value => value.repository = "other/repo", value => value.issueCount = 2, value => value.openCount = 0, value => value.issues[0].sha256 = "b".repeat(64)]) {
    const manifest = structuredClone(setup.manifest); change(manifest);
    await writeFile(join(setup.input, "manifest.json"), JSON.stringify(manifest));
    await assert.rejects(prepareImport(setup.input));
  }
});
test("GitHub comment counts, missing children and inconsistent parent relationships refuse import", async t => {
  for (const change of [value => value.issue.comments = 1, value => { value.subIssues = [{ number: 999 }]; value.collections.subIssues.count = 1; value.issue.sub_issues_summary.total = 1; }, value => value.issue.parent_issue_url = "https://api.github.com/repos/dvdtrsnk/semprec/issues/999"]) {
    const value = bundle(); change(value); const setup = await fixture(t, [value]);
    await assert.rejects(prepareImport(setup.input));
  }
});
test("historical malformed specs are imported with diagnostics, not rewritten or dropped", async t => {
  const value = bundle(); value.issue.body = "## Task\nHistorical task";
  const setup = await fixture(t, [value]); const report = await importExport(setup.input, setup.destination);
  assert.ok(report.diagnostics.length > 0);
  assert.equal(parseRecord(await readFile(join(setup.destination, "issues/items/gh-1.md"), "utf8")).body, value.issue.body);
});
test("local modifications refuse replay without overwriting modified content", async t => {
  const setup = await fixture(t); await importExport(setup.input, setup.destination);
  const path = join(setup.destination, "issues/items/gh-1.md"); const changed = `${await readFile(path, "utf8")}\nChanged locally`;
  await writeFile(path, changed); await assert.rejects(importExport(setup.input, setup.destination), /conflicts/);
  assert.equal(await readFile(path, "utf8"), changed);
});
test("export paths cannot traverse directories or escape through symlinks", async t => {
  const setup = await fixture(t); await writeFile(join(setup.root, "outside.json"), "outside");
  await symlink(join(setup.root, "outside.json"), join(setup.input, "linked.json"));
  for (const path of ["../outside.json", "/absolute", "linked.json"]) await assert.rejects(exportedFile(setup.input, path, digest("outside")));
});
test("binary attachments are checksum verified and unavailable attachments are explicitly reported", async t => {
  const value = bundle(); const bytes = Buffer.from([0, 255, 128, 13, 10]);
  value.attachments = [{ url: "https://example.com/file.bin", status: "downloaded", filename: "file.bin", path: "asset.bin", sha256: digest(bytes) }, { url: "https://example.com/missing.png", status: "unavailable", reason: "Source returned 404" }];
  const setup = await fixture(t, [value]); await writeFile(join(setup.input, "asset.bin"), bytes);
  const report = await importExport(setup.input, setup.destination);
  assert.deepEqual(await readFile(join(setup.destination, "issues/attachments/gh-1/file.bin")), bytes);
  assert.equal(report.unavailableAttachments[0].issue, "gh-1");
  const index = JSON.parse(await readFile(join(setup.destination, "issues/history/gh-1/attachments.json"), "utf8"));
  assert.deepEqual(index[0], { url: "https://example.com/file.bin", status: "downloaded", path: "issues/attachments/gh-1/file.bin", sha256: digest(bytes) });
  assert.equal(index[1].status, "unavailable");
});

test("duplicate attachment destinations and unknown statuses are refused before import writes", async t => {
  for (const status of ["duplicate", "unknown"]) {
    const value = bundle();
    const asset = { url: "https://example.com/file.bin", status: "downloaded", filename: "file.bin", path: "asset.bin", sha256: digest("asset") };
    value.attachments = status === "duplicate" ? [asset, { ...asset, url: "https://example.com/other.bin" }] : [{ ...asset, status: "unknown" }];
    const setup = await fixture(t, [value]); await writeFile(join(setup.input, "asset.bin"), "asset");
    await assert.rejects(importExport(setup.input, setup.destination), status === "duplicate" ? /Duplicate import destination/ : /Unknown attachment status/);
    await assert.rejects(readFile(join(setup.destination, "issues/items/gh-1.md")), { code: "ENOENT" });
  }
});
