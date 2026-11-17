import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { digest } from "./records.mjs";
import { assembleExport, attachmentUrls, normalizeTimelineReference, readExportListing } from "./assemble-export.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "semprec-export-assembly-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const save = async (path, value) => { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), JSON.stringify(value)); };
  const issue = { number: 21, state: "closed", body: "Archived specification", comments: 0, sub_issues_summary: { total: 0 } };
  await save("progress.json", { complete: true, pages: [{ page: 1, count: 1 }], issues: [{ number: 21 }] });
  await save("raw/list/1.json", [issue]);
  await save("raw/closing/1.json", [{ issueNumber: 21, closedByPullRequests: [] }]);
  await save("raw/timeline/21/1.json", []);
  await save("raw/timeline/21/complete.json", { complete: true, pages: 1, perPage: 25, count: 0 });
  return { root, save, issue, destination: join(root, "assembled") };
}

test("assembly verifies all-state source cache, preserves pagination evidence and is repeatable", async t => {
  const env = await fixture(t);
  const result = await assembleExport(env.root, env.destination, "2026-10-27T12:00:00Z");
  assert.equal(result.issueCount, 1); assert.equal(result.closedCount, 1); assert.equal(result.openCount, 0);
  const bundle = JSON.parse(await readFile(join(env.destination, "issues/21.json"), "utf8"));
  assert.deepEqual(bundle.issue, env.issue); assert.equal(bundle.collections.events.complete, true);
  assert.deepEqual(await assembleExport(env.root, env.destination, "2026-10-27T12:00:00Z"), result);
});
test("incomplete listing, closing coverage and timeline prevent assembled export writes", async t => {
  for (const kind of ["listing", "closing", "timeline"]) {
    const env = await fixture(t);
    if (kind === "listing") await env.save("progress.json", { complete: false });
    if (kind === "closing") await env.save("raw/closing/1.json", []);
    if (kind === "timeline") await env.save("raw/timeline/21/complete.json", { complete: false });
    await assert.rejects(assembleExport(env.root, env.destination, "2026-10-27T12:00:00Z"));
    await assert.rejects(readFile(join(env.destination, "manifest.json")), { code: "ENOENT" });
  }
});
test("listing pagination refuses gaps and full terminal pages", async t => {
  const env = await fixture(t);
  await env.save("progress.json", { complete: true, pages: [{ page: 1, apiPage: 2, perPage: 25, count: 1 }], issues: [{ number: 21 }] });
  await assert.rejects(readExportListing(env.root), /Non-contiguous/);
  await env.save("progress.json", { complete: true, pages: [{ page: 1, count: 10 }], issues: [{ number: 21 }] });
  await env.save("raw/list/1.json", Array.from({ length: 10 }, (_, index) => ({ number: index + 1 })));
  await assert.rejects(readExportListing(env.root), /terminal/);
});
test("attachment discovery deduplicates Markdown and native asset URLs without silently dropping them", async t => {
  const url = "https://github.com/user-attachments/assets/example";
  assert.deepEqual(attachmentUrls([`![image](${url})\n${url}`, "![diagram](https://example.com/diagram.png)"]), [url, "https://example.com/diagram.png"].sort());
  const env = await fixture(t); env.issue.body = `![image](${url})`;
  await env.save("raw/list/1.json", [env.issue]);
  await assert.rejects(assembleExport(env.root, env.destination, "2026-10-27T12:00:00Z"), { code: "ENOENT" });
  await env.save("raw/assets/21.json", [{ url, status: "unavailable", reason: "Source returned 404" }]);
  await assembleExport(env.root, env.destination, "2026-10-27T12:00:00Z");
  assert.equal(JSON.parse(await readFile(join(env.destination, "issues/21.json"), "utf8")).attachments[0].url, url);
});

test("bulk history proof is accepted only for the matching source issue and complete terminal page", async t => {
  const env = await fixture(t);
  const proof = { number: 21, collection: "timeline", perPage: 50, pages: [[{ event: "closed" }]], count: 1, complete: true };
  await env.save("raw/history/timeline-0.json", [proof]);
  await assembleExport(env.root, env.destination, "2026-10-27T12:00:00Z");
  const bundle = JSON.parse(await readFile(join(env.destination, "issues/21.json"), "utf8"));
  assert.deepEqual(bundle.events, [{ event: "closed" }]);
  for (const change of [value => value.number = 999, value => value.collection = "comments", value => value.complete = false, value => value.count = 2]) {
    const changed = structuredClone(proof); change(changed);
    await env.save("raw/history/timeline-0.json", [changed]);
    await assert.rejects(assembleExport(env.root, join(env.root, "refused"), "2026-10-27T12:00:00Z"));
  }
});

test("timeline reference normalization is idempotent and preserves comments and source identity", () => {
  const input = { event: "cross-referenced", actor: { login: "owner" }, source: { type: "issue", issue: { id: 42, node_id: "I_42", number: 42, title: "Source", html_url: "https://github.com/dvdtrsnk/semprec/issues/42", repository_url: "https://api.github.com/repos/dvdtrsnk/semprec", state: "closed", body: "Original source body", repository: { duplicate: true } } } };
  const normalized = normalizeTimelineReference(input);
  assert.equal(normalized.source.issue.number, 42);
  assert.equal(normalized.source.issue.body, undefined);
  assert.match(normalized.source.issue.bodySha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(normalizeTimelineReference(normalized), normalized);
  assert.deepEqual(normalized.actor, input.actor);
  const comment = { event: "commented", body: "Complete original comment" };
  assert.deepEqual(normalizeTimelineReference(comment), comment);
});

test("downloaded attachment bytes are checksum verified and copied into the assembled export", async t => {
  const env = await fixture(t); const url = "https://example.com/diagram.png";
  env.issue.body = `![diagram](${url})`; await env.save("raw/list/1.json", [env.issue]);
  const bytes = Buffer.from([0, 255, 13, 10]);
  await mkdir(join(env.root, "assets")); await writeFile(join(env.root, "assets/diagram.png"), bytes);
  await env.save("raw/assets/21.json", [{ url, status: "downloaded", path: "assets/diagram.png", filename: "diagram.png", sha256: digest(bytes) }]);
  await assembleExport(env.root, env.destination, "2026-10-27T12:00:00Z");
  assert.deepEqual(await readFile(join(env.destination, "assets/diagram.png")), bytes);
  await writeFile(join(env.root, "assets/diagram.png"), "changed");
  await assert.rejects(assembleExport(env.root, join(env.root, "refused"), "2026-10-27T12:00:00Z"), /checksum/);
});
