import assert from "node:assert/strict";
import test from "node:test";
import { bodyHash, renderMetadata, prepareManifest, validateManifest, migrateEntry } from "./backfill-model-tiers.mjs";

const before = "**Blocked by:** #7, #8\n\n## Context\nExisting context.\n\n## Task\nDo exactly this.\n\n## Acceptance criteria\n1. Pass.\n";
const rationale = "Concurrent state crosses process boundaries.";
const after = renderMetadata(before, "high", rationale);
const entry = { number: 9, kind: "implementation", modelTier: "high", beforeBody: before, beforeBodySha256: bodyHash(before), afterBody: after, afterBodySha256: bodyHash(after) };

test("metadata rendering preserves every original line and CRLF", () => {
  assert.ok(after.startsWith("**Blocked by:** #7, #8\n**Model tier:** high\n"));
  assert.equal(after.replace("**Model tier:** high\n", "").replace(`\n\nModel tier rationale: ${rationale}`, ""), before);
  const windows = renderMetadata(before.replaceAll("\n", "\r\n"), "high", rationale);
  assert.equal(windows.replaceAll("\r\n", "\n"), after);
  assert.equal(renderMetadata(after, "high", rationale), after);
  assert.throws(() => renderMetadata(after, "medium", rationale), /reassessment/);
  assert.throws(() => renderMetadata(before, "high", ""), /Invalid/);
});
test("preparation checks complete snapshot and exact assessed body hashes", () => {
  const assessment = { version: 1, repo: "o/r", assessments: [{ number: 9, kind: "implementation", modelTier: "high", rationale, sourceBodySha256: bodyHash(before) }] };
  const issues = [{ number: 9, body: before, updatedAt: "2026-10-08T00:00:00Z" }];
  const manifest = prepareManifest(assessment, issues);
  assert.equal(manifest.entries[0].afterBody, after);
  assert.throws(() => prepareManifest(assessment, [{ ...issues[0], body: before + "Edited" }]), /changed/);
  assert.throws(() => prepareManifest(assessment, [...issues, { number: 10, body: before }]), /every open issue/);
  assert.throws(() => validateManifest({ ...manifest, entries: [{ ...entry, afterBodySha256: "wrong" }] }), /body\/hash/);
});

test("malformed existing tier headers require explicit repair before backfill", () => {
  const bodies = [
    after.replace("**Model tier:** high", "**Model tier:** high\n**Model tier:** low"),
    before.replace("## Context", "**Model tier:** high\n\n## Context"),
    after.replace("**Model tier:** high", "**Model tier:** unknown"),
  ];
  for (const body of bodies) assert.throws(() => renderMetadata(body, "high", rationale), /repair it explicitly/);
});

function fake(body = before) {
  const events = []; const ledger = {};
  let current = body;
  const api = { read: async () => { events.push("read"); return { body: current, state: "open" }; }, write: async (number, body) => { assert.equal(number, 9); events.push("write"); current = body; } };
  const save = async () => { events.push(`save:${ledger[9]}`); };
  return { api, events, ledger, save, body: () => current };
}
test("exempt entries remain unchanged in every mode without API or ledger access", async () => {
  for (const mode of ["dry-run", "apply", "rollback"]) {
    for (const kind of ["epic", "manual"]) {
      const state = fake();
      const exempt = { ...entry, kind, afterBody: before, afterBodySha256: bodyHash(before) };
      assert.equal(await migrateEntry(exempt, state.api, mode, state.ledger, state.save), "unchanged");
      assert.deepEqual(state.events, []);
      assert.deepEqual(state.ledger, {});
      assert.equal(state.body(), before);
    }
  }
});
test("dry run reads current state and performs zero writes", async () => {
  const state = fake();
  assert.equal(await migrateEntry(entry, state.api, "dry-run", state.ledger, state.save), "would-change");
  assert.deepEqual(state.events, ["read"]);
  assert.equal(state.body(), before);
});
test("an issue closed after assessment is skipped without a write or ledger change", async () => {
  const state = fake();
  state.api.read = async () => { state.events.push("read"); return { body: before, state: "closed" }; };
  assert.equal(await migrateEntry(entry, state.api, "apply", state.ledger, state.save), "closed");
  assert.equal(await migrateEntry(entry, state.api, "dry-run", state.ledger, state.save), "closed");
  assert.deepEqual(state.events, ["read", "read"]);
  assert.deepEqual(state.ledger, {});
});
test("apply persists intent, writes only body, verifies and resumes idempotently", async () => {
  const state = fake();
  assert.equal(await migrateEntry(entry, state.api, "apply", state.ledger, state.save), "applied");
  assert.deepEqual(state.events, ["read", "save:applying", "write", "read", "save:applied"]);
  assert.equal(state.body(), after);
  state.events.length = 0;
  assert.equal(await migrateEntry(entry, state.api, "apply", state.ledger, state.save), "already-target");
  assert.deepEqual(state.events, ["read", "save:applied"]);
});
test("conflicts are never overwritten; rollback only touches the recorded target", async () => {
  const changed = fake(after + "User edit"); changed.ledger[9] = "applied";
  assert.equal(await migrateEntry(entry, changed.api, "rollback", changed.ledger, changed.save), "conflict");
  assert.deepEqual(changed.events, ["read"]);
  const applied = fake(after); applied.ledger[9] = "applied";
  assert.equal(await migrateEntry(entry, applied.api, "rollback", applied.ledger, applied.save), "rolled-back");
  assert.equal(applied.body(), before);
  assert.equal(await migrateEntry(entry, applied.api, "rollback", applied.ledger, applied.save), "already-target");
});
test("a crash after PATCH can recover from intent without repeating the write", async () => {
  const state = fake(after); state.ledger[9] = "applying";
  assert.equal(await migrateEntry(entry, state.api, "apply", state.ledger, state.save), "already-target");
  assert.deepEqual(state.events, ["read", "save:applied"]);
});
test("unknown write failure is not retried and the saved intent is retained", async () => {
  const state = fake(); state.api.write = async () => { throw new Error("connection lost after request"); };
  await assert.rejects(migrateEntry(entry, state.api, "apply", state.ledger, state.save), /connection lost/);
  assert.equal(state.ledger[9], "applying");
  assert.deepEqual(state.events, ["read", "save:applying"]);
});
test("an unexpected post-write body requires inspection and never claims success", async () => {
  const state = fake(); state.api.write = async () => {};
  await assert.rejects(migrateEntry(entry, state.api, "apply", state.ledger, state.save), /changed during write/);
  assert.equal(state.ledger[9], "applying");
});
