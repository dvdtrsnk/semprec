# Batch 29 grouped owner and contract reconciliation

The delegated controller approves these exact corrections for local work.
Original source Task/AC changes below are explicit, not inherited permissions.
Per-member Touches remain authoritative; the aggregate union transfers none.
Six aggregate AC remain unchanged. No final gate, release or deployment is granted.

## Downloaded covers: gh1655, reused by gh1706

Use the typed downloaded-byte cover and library-specific prepared storage/commit
handoff in the new cover ADR. Amend the impossible CreateBlobInput-bytes phrase;
do not invent keys or commit standalone blob rows before the book reference.
Allow libraryMetadataJob cover lifecycle, internal libraryCoverStorage.ts,
worker storage argument, library.test.ts real storage/transaction controls and
the narrowly required LocalFs partial-cleanup correction in mail/blobStorage.ts
with mail/**tests**/blobStorage.unit.test.ts. No blob classification writer,
Files filing, root helper export, new storage root or general upload refactor.
The poster fetcher reuses the same downloaded-byte representation; its source,
secret, HTTP admission and outcome rules otherwise remain unchanged.

## Outcome compatibility: gh1708

Follow the explicit reader/privacy bridge B then outcome writer W ADR, preserving
error_code from0092 and adding only source plus the widened status CHECK. Make
B a coherent checkpoint before new stored literals, capture its real built
reader for local W-row tests, and preserve the no-secret failure boundary across
rollback. Previous-release compatibility means B as W's actually deployed
immediate predecessor; unbridged old code is not compatible. Local artifact
proof is not actual two-release deployment or a historical release binary.
Authorize the existing migrationCompatibility.test.ts for old-row preservation
and exact bridge-reader controls. Production activation/rollback remains NOT RUN.

## Propagation: gh1593

Use the new hop-budget ADR: client-bound domain ALS, keys including rule/source/
hop1..5, normal same-budget replace, downstream scheduling on unchanged active
targets, no value/invalidations for no-op, and item-before-link reservations.
Authorize only the new internal valueLinks/propagationContext.ts alongside
already scoped catalog/hooks/handler/tests; do not change generic hook/writer
identity or queue internals. This explicitly replaces the old depthless key
and write-only-next-hop clauses, not the tenant/owner/dry-run guarantees.

## Recording reads and timestamps: gh1624, gh1627, gh1696

Extend the existing typed readRecordingRequest owner in recordingIntake.ts with
nullable language, numSpeakersExact, numSpeakersMin and projectItemId, rejecting
malformed stored values and simultaneous exact/min forms. Keep eventId and
recordedAt semantics, tenant scope and read-only behavior. Extend only its
recordingIntake.test.ts exact-shape/owner/foreign/random fixtures as necessary.
Do not query recording_requests directly from transcribe or add a public helper.

For gh1624 retain prepare's existing upload-time convention sourceBlob.createdAt
through the existing blob/source owner. This is canonical first storage time;
a deduplicated later upload can reuse an older timestamp. Do not claim request
arrival accuracy, use now()/updatedAt as a replacement or implement future
items.createdAt early. Provisional date remains recorded_at then that existing
fallback, with checkpoint/replay unchanged and later prepare refinement.

For gh1627 explicitly permit audioGatewayClient.unit.test.ts and
audioProviders/**tests**/pyannoteProvider.unit.test.ts for actual existing
transport/provider parameter mapping and omission/error controls. These were
edited before their per-member scope grant; preserve the incident, do not claim
prior authorization or test evidence. The new permission begins at refreeze.

## Opt-in automation read composition: gh1768

Use one typed readAutomationForItems facade/port method backed by the existing
itemAutomationStore batch owner, not a reverse application-to-data import.
Authorize chokePoint.ts, shared port.ts and rows.ts, the exact facade method
catalog in publicSurface.test.ts, existing genericApplicationService.test.ts,
API itemsHandler.ts and adapter/itemEnvelope.ts and itemQueryEnvelope.ts plus
existing genericOperationsContract.test.ts for this include only. Preserve all
old include combinations and byte-identical absent-include behavior. Request
item/get, database/query and view/query through actual generic/REST boundaries;
read returned page IDs once with tenant-scoped retry-heartbeat join, no per-row
query or new root store export. Existing optional/required port typing governs;
report any additional actual fake/consumer owner before changing it.

For gh1627, the existing gateway diarize(pool, context, invoke) remains the
accounting wrapper. Pass validated numSpeakers through its existing invoke
closure to the actual provider request; preserve accounting and do not invent
a public request argument for a wrapper that has none. Prove both omission and
exact/min mapping at the real client/handler/provider boundaries.

## Unsupported source configuration: gh1655 and gh1708

Follow the supported-live-source retry ADR. Use one pure internal
libraryMetadataConfig.ts with a fixed typed configuration error and the actual
configured-source set. Validate producer, sweep, entry and dispatcher before
item/automation side effects; recognized invalid config is not a provider
sourceUnavailable outcome. Existing bounded attempts for already queued legacy
jobs remain, but unchanged invalid live config enqueues no next metadata batch.
A repaired config may resume normal retry. Scheduler diagnostics retain their
own policy; no new durable outcome, schema, code literal, queue framework or
missing-token reclassification is authorized. Existing fake-fetcher tests must
use a real supported configured source; injection remains the provider seam.

## Supported-source fixture compatibility: gh1708

Authorize only the three existing library fixture source values test -> tmdb in
sempProblemsProducers.test.ts failJob and tenantIsolationJobs.test.ts retry sweep
and library task payload. The former retains its injected failing fetcher and
SEMP deduplication/count assertions. The latter retains its task composition,
empty-database sweep and tenant effect assertions; do not add a live fetcher.
This keeps those existing branches reachable after the supported-source entry
guard. It grants no assertion, outcome, transport, provider or production change.
Fold execution into the next relevant coherent group; no extra standalone retry.

## Trusted tenant propagation job keys: gh1593

Apply the narrow trusted-tenant job-key ADR. The existing queue envelope stamps
tenantId into payload only; Graphile keys remain global. The propagation owner
therefore constructs valueLinksPropagate:tenantId:ruleKey:sourceItemId:hop from
trusted tenant scope, never a payload tenant. Keep the prior hop budgets,
replace behavior, lane and transaction rules. No queue framework change.

## Automation batch-read boundary: gh1768

The initial direct library import in chokePoint.ts violates the existing domain
boundary. Apply the automation batch-read registry ADR: one typed callback in
hooks.ts, composed through domainWriteHooks.ts with the existing store owner,
called by the facade inside its existing transaction. The previous instruction
to use the existing owner remains; it does not authorize importing it directly
from chokePoint/. Keep exactly one query for a nonempty returned page, actual
tenant controls and no absent-include work. No boundary/baseline change, generic
projection framework, helper root export or duplicated SQL is authorized.

## Automation client receipt: gh1768

Authorize tenantIsolationRealtime.test.ts only for actual found/notFound
status-only library jobs reaching the owning authenticated realtime socket
through the production post-commit invalidation publisher; retain foreign-tenant
absence with the existing ordered sentinel and rollback-no-delivery controls.
Use existing runtime-role and socket composition, bounded injected provider
fixtures and actual library task owner. A hook observation alone remains partial
for client receipt. No production transport, provider, timeout or authentication
change is authorized. Fold this evidence into a coherent targeted group.

## Both transcription producer jobs: gh1624

Authorize recordingsHandler.test.ts for actual POST /api/recordings and
transcriptionActions.test.ts for actual core.filesTranscriptionTrigger. Assert
both transcriptionCreate and transcriptionJob payloads, trusted tenant envelope
and expected lane/key registration from each named producer, with successful
commit and rollback-or-refusal/no-effect controls. Preserve prior assertions
and use existing queue inspection, runtime-role and HTTP harnesses. Mock no
producer or enqueue owner; no provider call or production scope is added.
Consolidating the duplicate recordingIntake Touches entry preserves enqueue
and typed reader permissions, event/time invariance and exact-shape/tenant
controls. Source Task/AC and outer six criteria remain unchanged.
