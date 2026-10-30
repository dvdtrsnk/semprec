import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRecord, digest, diagnoseCatalog, serializeRecord } from "./records.mjs";
import { validateCatalog } from "./validation.mjs";

const body = "**Blocked by:** none\n\n## Context\nOne mechanism.\n\n## Task\nDeliver it.\n\n## Touches\n- example.txt\n\n## Scope\n### In scope\nThe mechanism.\n### Out of scope\nOther work.\n\n## Acceptance criteria\nThe mechanism works.\n";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "semprec-local-lifecycle-")); t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ["items", "handovers", "migration"]) await mkdir(join(root, "issues", path), { recursive: true });
  await writeFile(join(root, "issues/migration/state.json"), JSON.stringify({ schemaVersion: 1, repository: "dvdtrsnk/semprec", authority: "repository" }));
  const save = issue => writeFile(join(root, `issues/items/${issue.metadata.id}.md`), serializeRecord(issue));
  return { root, save };
}

test("only unchanged imported records may retain their recorded historical diagnostics", async t => {
  const { root, save } = await fixture(t);
  // A missing Touches section is a specification error the validator reports.
  const issue = createRecord({ title: "Historical", body: body.replace("## Touches\n- example.txt\n\n", "") }); await save(issue);
  const catalog = new Map([[issue.metadata.id, issue]]);
  const diagnostics = diagnoseCatalog(catalog);
  await writeFile(join(root, "issues/migration/manifest.json"), JSON.stringify({ diagnostics, files: [{ path: `issues/items/${issue.metadata.id}.md`, sha256: digest(serializeRecord(issue)) }] }));
  assert.equal((await validateCatalog(root, catalog)).errors.length, 0);
  assert.equal((await validateCatalog(root, catalog)).historical.length, 1);
  issue.body += "Edited invalid specification";
  assert.equal((await validateCatalog(root, catalog)).errors.length, 1);
});
