import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAdrs, parseAdr } from "./adr.mjs";

function text(area, status = "accepted", date = "2026-09-10") {
  return `---\nstatus: ${status}\ndate: ${date}\narea: [${area}]\nsupersedes: []\nsuperseded-by: null\n---\n\n# Decision\n`;
}
test("platform discovery includes shared rules and historical Apple candidates without copying ADRs", async t => {
  const root = await mkdtemp(join(tmpdir(), "semprec-adr-")); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "docs/adr"); await mkdir(directory, { recursive: true });
  for (const [name, area, status] of [["backend", "backend", "accepted"], ["web", "web", "accepted"], ["shared", "cross-cutting", "accepted"], ["mobile", "mobile", "accepted"], ["old-apple", "apple", "accepted"], ["retired", "apple", "superseded"]])
    await writeFile(join(directory, `2026-09-10-${name}.md`), text(area, status));
  const names = records => records.map(record => record.filename);
  const android = names(await listAdrs(root, { platform: "android" }));
  assert.deepEqual(android, ["2026-09-10-mobile.md", "2026-09-10-old-apple.md", "2026-09-10-shared.md"]);
  for (const platform of ["mobile", "shared", "apple", "ios", "macos"]) assert.deepEqual(names(await listAdrs(root, { platform })), android);
  assert.deepEqual(names(await listAdrs(root, { platform: "backend" })), ["2026-09-10-backend.md", "2026-09-10-shared.md"]);
  assert.deepEqual(names(await listAdrs(root, { platform: "web" })), ["2026-09-10-shared.md", "2026-09-10-web.md"]);
  assert.equal((await listAdrs(root, { all: true })).length, 6);
  await assert.rejects(listAdrs(root, { platform: "typo" }), /Unknown platform/);
});
test("ADR parser rejects missing, ambiguous and unknown metadata and newly introduced apple tags", () => {
  assert.equal(parseAdr(text("backend, web"), "2026-09-10-example.md").area.length, 2);
  for (const content of ["no frontmatter", text("unknown"), text("backend, backend"), text("backend", "unknown"), text("backend").replace("status: accepted", "status: accepted\nstatus: accepted"), text("backend").replace("# Decision", "Decision"), text("apple", "accepted", "2026-10-24")])
    assert.throws(() => parseAdr(content, "2026-09-10-example.md"));
});
