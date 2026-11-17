import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog, blockers, specDigest } from '../../../.github/scripts/issues/records.mjs';
import { handoverIds } from '../../../.github/scripts/issues/store.mjs';

const idPattern = /^(gh-[1-9]\d*|sp-[0-9a-f-]{36})$/;
const hashPattern = /^[0-9a-f]{64}$/;

export function sourceSnapshot(issue) {
  return issue.body.split('\n').slice(2).join('\n').trim()
    .replace(/^## Backend-only delivery scope\n[\s\S]*?(?=^## |$(?![\s\S]))/gm, '').trim()
    .replace(/^(#{1,6}) /gm, '##$1 ');
}

export function validateManifest(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Manifest must be an object');
  assert.equal(value.schemaVersion, 1, 'Unknown manifest schema');
  assert.equal(value.scope, 'backend-only');
  assert(typeof value.programIssue === 'string' && idPattern.test(value.programIssue));
  assert(typeof value.baseline === 'string' && /^[0-9a-f]{40}$/.test(value.baseline));
  for (const key of ['sourceCount', 'activeBatchCount', 'heldBatchCount'])
    assert(Number.isSafeInteger(value[key]) && value[key] >= 0, `Invalid ${key}`);
  assert(Array.isArray(value.batches), 'Missing batches');
  for (const batch of value.batches) {
    assert(batch && typeof batch === 'object', 'Invalid batch');
    assert(typeof batch.id === 'string' && idPattern.test(batch.id), 'Invalid batch ID');
    assert(['proposed', 'merged', 'held'].includes(batch.status), 'Invalid batch status');
    assert(batch.sequence === null || Number.isSafeInteger(batch.sequence) && batch.sequence > 0, 'Invalid sequence');
    assert(typeof batch.specSha256 === 'string' && hashPattern.test(batch.specSha256), 'Invalid batch hash');
    assert(Array.isArray(batch.members) && batch.members.length > 0, 'Empty batch');
    for (const member of batch.members) {
      assert(member && typeof member === 'object', 'Invalid member');
      assert(typeof member.id === 'string' && idPattern.test(member.id), 'Invalid source ID');
      assert(typeof member.specSha256 === 'string' && hashPattern.test(member.specSha256), 'Invalid source hash');
      assert(Array.isArray(member.dependencies) && member.dependencies.every(id => typeof id === 'string' && idPattern.test(id)), 'Invalid dependencies');
      assert(member.parent === null || typeof member.parent === 'string' && idPattern.test(member.parent), 'Invalid source parent');
    }
  }
  return value;
}

export function verifyPlan(input, catalog, handovers) {
  const manifest = validateManifest(input);
  const program = catalog.get(manifest.programIssue);
  assert.equal(program?.metadata.kind, 'epic', 'Missing delivery program epic');
  const batches = new Map();
  const owners = new Map();
  let active = 0, held = 0, previous;
  for (const batch of manifest.batches) {
    assert(!batches.has(batch.id), `Duplicate batch ${batch.id}`);
    batches.set(batch.id, batch);
    const issue = catalog.get(batch.id);
    assert.equal(issue?.metadata.kind, 'implementation', `Missing batch ${batch.id}`);
    assert.equal(issue.metadata.parent, manifest.programIssue, 'Wrong batch parent');
    assert.equal(specDigest(issue), batch.specSha256, `Batch spec drift: ${batch.id}`);
    assert(issue.body.length <= 60000, 'Batch exceeds model metadata limit');
    assert(issue.metadata.labels.includes('execution:batch'), 'Missing batch routing label');
    if (batch.status !== 'held') {
      active++;
      assert.equal(batch.sequence, active, 'Non-contiguous main sequence');
      assert.deepEqual(blockers(issue), previous ? [previous] : [], 'Missing sequential gate');
      previous = batch.id;
    } else {
      held++;
      assert.equal(batch.sequence, null, 'Held work cannot have a main sequence');
      assert(issue.metadata.labels.includes('agent:blocked'), 'Held work must be blocked');
    }
    for (const [position, member] of batch.members.entries()) {
      assert(!owners.has(member.id), `Duplicate assignment: ${member.id}`);
      owners.set(member.id, { batch, position });
      const source = catalog.get(member.id);
      assert.equal(source?.metadata.kind, 'implementation', `Missing source ${member.id}`);
      assert.equal(specDigest(source), member.specSha256, `Source spec drift: ${member.id}`);
      assert.equal(source.metadata.parent, member.parent, 'Source feature parent changed');
      assert.deepEqual(blockers(source), member.dependencies, 'Source blockers changed');
      assert(source.metadata.labels.includes('execution:batch-source'), 'Missing source routing label');
      assert.deepEqual(source.metadata.labels.filter(label => label.startsWith('delivery:')), [`delivery:${batch.id}`], 'Wrong source route');
      if (source.metadata.state === 'open') {
        assert(!source.metadata.labels.includes('agent:ready'), 'Source is individually queued');
        assert(source.metadata.labels.includes('agent:blocked'), 'Open source is not blocked');
      }
      // A merged batch is a routing group of the parallel program: its withdrawn aggregate no longer
      // carries the authoritative requirement text, so only a sequential batch must embed the snapshot.
      if (batch.status !== 'merged') {
        const expected = `### Requirement ${member.id}: ${source.metadata.title}\n\n${sourceSnapshot(source)}`;
        assert(issue.body.includes(expected), `Missing or changed requirement snapshot: ${member.id}`);
      }
    }
  }
  assert.equal(active, manifest.activeBatchCount, 'Wrong main batch count');
  assert.equal(held, manifest.heldBatchCount, 'Wrong held batch count');
  assert.equal(owners.size, manifest.sourceCount, 'Wrong source count');
  for (const issue of catalog.values()) {
    if (issue.metadata.kind === 'implementation' && issue.metadata.state === 'open' && !batches.has(issue.metadata.id))
      assert(owners.has(issue.metadata.id), `Unassigned open requirement: ${issue.metadata.id}`);
  }
  for (const [id, owner] of owners) {
    for (const dependency of blockers(catalog.get(id))) {
      const target = owners.get(dependency);
      if (!target) {
        const prerequisite = catalog.get(dependency);
        assert(prerequisite?.metadata.state === 'closed' && prerequisite.metadata.stateReason === 'completed' && handovers.has(dependency), `Undelivered prerequisite: ${dependency}`);
      } else if (target.batch.id === owner.batch.id) {
        assert(target.position < owner.position, `Internal forward dependency: ${id} -> ${dependency}`);
      } else if (owner.batch.status !== 'held') {
        assert(target.batch.status !== 'held' && target.batch.sequence < owner.batch.sequence, `Future/held dependency: ${id} -> ${dependency}`);
      } else {
        assert(blockers(catalog.get(owner.batch.id)).includes(target.batch.id), 'Held dependency missing from batch');
      }
    }
    if (id === 'gh-1086') {
      const gate = catalog.get(owner.batch.id);
      assert(gate.metadata.labels.includes('execution:security-gate') && gate.metadata.labels.includes('execution:parent-decision'), 'Security review is not a parent decision gate');
    }
  }
  return { sources: owners.size, mainBatches: active, heldBatches: held };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  const manifest = JSON.parse(await readFile(resolve(root, 'issues/batches/backend/manifest.json'), 'utf8'));
  console.log(JSON.stringify(verifyPlan(manifest, await loadCatalog(root), await handoverIds(root))));
}
