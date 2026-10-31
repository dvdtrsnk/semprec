import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadCatalog, specDigest } from '../../../.github/scripts/issues/records.mjs';
import { handoverIds } from '../../../.github/scripts/issues/store.mjs';
import { verifyPlan, validateManifest } from './verify.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const original = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8'));
const catalog = await loadCatalog(root);
const handovers = await handoverIds(root);

test('the complete real plan preserves all sources and their dependency order', () => {
  assert.deepEqual(verifyPlan(original, catalog, handovers), { sources: 665, mainBatches: 74, heldBatches: 2 });
});

test('malformed manifest inputs are rejected at the file boundary', () => {
  for (const input of [null, [], {}, { ...original, schemaVersion: 2 }]) assert.throws(() => validateManifest(input));
  const input = structuredClone(original);
  input.batches[0].members[0].dependencies = [42];
  assert.throws(() => validateManifest(input), /Invalid dependencies/);
});

test('a source assigned twice is refused', () => {
  const input = structuredClone(original);
  input.batches[0].members.push(input.batches[0].members[0]);
  assert.throws(() => verifyPlan(input, catalog, handovers), /Duplicate assignment/);
});

test('an unassigned newly added requirement cannot silently escape coverage', () => {
  const changed = structuredClone(catalog);
  const source = structuredClone(changed.get(original.batches[0].members[0].id));
  source.metadata.id = 'gh-999999';
  changed.set(source.metadata.id, source);
  assert.throws(() => verifyPlan(original, changed, handovers), /Unassigned open requirement/);
});

test('specification drift invalidates frozen source and aggregate snapshots', () => {
  const sourceId = original.batches[0].members[0].id;
  for (const id of [sourceId, original.batches[0].id]) {
    const changed = structuredClone(catalog);
    changed.get(id).body += '\nChanged requirement.\n';
    assert.throws(() => verifyPlan(original, changed, handovers), /spec drift/);
  }
});

test('changing the aggregate hash cannot conceal missing source acceptance criteria', () => {
  const changed = structuredClone(catalog), input = structuredClone(original);
  const batch = changed.get(input.batches[0].id);
  batch.body = batch.body.replace('#### Acceptance criteria', '#### Omitted criteria');
  input.batches[0].specSha256 = specDigest(batch);
  assert.throws(() => verifyPlan(input, changed, handovers), /requirement snapshot/);
});

test('source dispatch is refused while aggregate work is pending', () => {
  const changed = structuredClone(catalog);
  changed.get(original.batches[0].members[0].id).metadata.labels.push('agent:ready');
  assert.throws(() => verifyPlan(original, changed, handovers), /individually queued/);
});

test('breaking the predecessor chain or intra-batch order fails validation', () => {
  const changed = structuredClone(catalog), input = structuredClone(original);
  const batch = changed.get(input.batches[1].id);
  batch.body = batch.body.replace(/^\*\*Blocked by:\*\*.*$/m, '**Blocked by:** none');
  input.batches[1].specSha256 = specDigest(batch);
  assert.throws(() => verifyPlan(input, changed, handovers), /sequential gate/);
  const reordered = structuredClone(original);
  const index = reordered.batches.findIndex(b => b.members.some((m, i) => m.dependencies.some(d => b.members.slice(0, i).some(previous => previous.id === d))));
  reordered.batches[index].members.reverse();
  assert.throws(() => verifyPlan(reordered, catalog, handovers), /Internal forward dependency/);
});

test('completed prerequisites need real handovers and production sign-off needs a human gate', () => {
  assert.throws(() => verifyPlan(original, catalog, new Set()), /Undelivered prerequisite/);
  const changed = structuredClone(catalog);
  const gate = original.batches.find(b => b.members.some(m => m.id === 'gh-1086'));
  changed.get(gate.id).metadata.labels = changed.get(gate.id).metadata.labels.filter(l => l !== 'execution:external-gate');
  assert.throws(() => verifyPlan(original, changed, handovers), /not a human gate/);
});

test('a valid-looking reversed chain still fails its actual source dependency checks', () => {
  const changed = structuredClone(catalog), input = structuredClone(original);
  const main = input.batches.filter(batch => batch.status === 'proposed').reverse();
  const held = input.batches.filter(batch => batch.status === 'held');
  input.batches = [...main, ...held];
  for (const [index, entry] of main.entries()) {
    entry.sequence = index + 1;
    const batch = changed.get(entry.id);
    const predecessor = index ? main[index - 1].id : 'none';
    batch.body = batch.body.replace(/^\*\*Blocked by:\*\*.*$/m, `**Blocked by:** ${predecessor}`);
    entry.specSha256 = specDigest(batch);
  }
  assert.throws(() => verifyPlan(input, changed, handovers), /Future\/held dependency/);
});
