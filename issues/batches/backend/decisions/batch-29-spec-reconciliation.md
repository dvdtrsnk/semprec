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

## Missing or trashed propagation source: gh1593

Task5 live-source recomputation governs existing queued propagation. Replace
Task8’s contradictory no-write test wording with no contribution from a
missing/trashed source. The handler must still find existing on links from the
queued source identity and recompute each target from every live source under
the existing reservations and owner. Remaining live values may replace the
old value; an empty union uses the existing empty/null property or relation
representation. Invalidate only a changed target and preserve on/broken state.
A missing/trashed source is not a write-admission guard; never write that source.
This does not add source-trash scheduling or cleanup of source/link rows, which
remain gh1656. Deleting the last via edge still deletes the link and preserves
the current value as own, as the separate existing decision requires. No new
lock, owner, protocol or production path is granted. Keep earlier contradictory
tests/results as history and map sufficient existing empty/remaining-union
controls to the corrected specification without an automatic repeat campaign.

## Complete R1 grouped disposition

R1 report SHA256 60776c6f048df057fbaa3ef5b89ec479b1bf033e7d22701dceb06b8229f1248d
and reviewed ledger SHA256 5211d1ffbc6ace15a176b59bdde6f3978e160c2a46c2d38b19b4eca6a60da5f7
remain immutable. Full read window ended before this decision. Repair the two
Google Books defects, required propagation schedules, normalized tenant HTTP
oracle controls, inaccurate ledger carry/locators and stale comment in their
already approved owners. Corrected ledgers must distinguish body-only identity,
fixture changes, earlier snapshots and actual later execution. No final gate
or whole-criterion PASS follows from those repairs.

### Gh1706 documented year search

The official TMDB OpenAPI lists no year query parameter for multi. It documents
primary_release_year for movie and first_air_date_year for TV; TV's broader year
parameter also searches episode dates and is not selected here. Sources:
https://developer.themoviedb.org/reference/search-multi.md,
https://developer.themoviedb.org/reference/search-movie.md,
https://developer.themoviedb.org/reference/search-tv.md.
The parent inspected these docs, not the provider API; undocumented multi-year
behavior is unproved.

Without a supplied year, retain one bounded multi-search page and skip people.
With a year, request one bounded page from each documented movie and TV search,
using name plus primary_release_year or first_air_date_year respectively.
Merge their checked movie/TV results and use the existing deterministic title/
year ranking, followed by details for the winner and at most three alternatives.
Do not append the year to the title, send an undocumented multi filter, crawl
all pages or silently fall back to an unrestricted search. A required endpoint
error or malformed body keeps the existing fixed outcome mapping rather than
becoming a successful partial candidate set. Preserve token header/privacy,
HTTP/storage bounds, safe cover download and missing-token behavior. Fixtures
must assert exact request names/years, no-year multi, both media shapes, merge,
wrong-year distractors, empty and failed/malformed endpoint results. This changes
only gh1706 Task1's impossible literal multi-year contract, not its AC or scope.

### Gh1624 observed fast-job preservation

Apply the new recording-intake fast-job ADR in the existing enqueue/intake and
recordingIntake.test.ts owners. The earlier no-replace rule extends to the fast
key specifically in recording intake under the same Files reservation. Preserve
observed queued/running identity, attempts and payload; inspect missing keys
independently. Do not globally change replace semantics for requeue/rerun or
non-recording callers. Existing shape/owner/foreign/random reader controls remain
in scope. Task3 wording was compressed without changing create/checkpoint,
provisional-date, canonical first-storage/dedup caveat, later refinement or sole
writer semantics. The prior accepted ADR body remains untouched.

### Gh1624 worker lifecycle fault seam

Authorize a narrowly typed local worker-start dependency in the existing
queueRuntime.ts composition options, defaulting to the actual runWorker. Its
input is the existing worker options; its return contract exposes only the
stop promise owned by this runtime. Do not require an unchecked cast to a full
Graphile Runner, export a package helper, alter the queue framework, task lists,
concurrency or serve defaults. This is an explicit exception to the prior
no-runner-replacement test direction for lifecycle fault controls only.

In queueRuntime.test.ts the starter may reject second startup or return typed
stop handles that reject, to prove exact cleanup/error branches. Assert primary
error identity after successful cleanup, AggregateError ordering and cause when
cleanup also fails, both stop attempts and preserved failures, and repeated stop
calling each handle once. Keep such injected lifecycle controls separate from
actual-worker evidence. The successful concurrency/fast-create scenario must
still use both real workers, actual task owners and bounded gateway fakes.
No timeout, auth, environment, process-kill policy or production lifecycle is
changed. No additional test path is needed beyond current gh1624 Touches.

Bundle confirmed repairs, coherent targeted validation and exact changed/
unchanged carry, then the one remaining focused R2 in the same reviewer context.
No third review or final verify is authorized by this refreeze.

## Verify8b89 compatibility repair scope

The actual unchanged verify on 8b893c59 remains FAIL in integration: nine failed
tests plus a suite setup failure, 7033 passed and five skipped. Earlier phases
passed; E2E remains NOT RUN. No inherited exception or successful verify is
claimed. R1/R2 are exhausted; the parent disposes subsequent finite deltas.

For gh1624, authorize the existing transcribe tenantIsolationJobs.test.ts to
register the real transcriptionCreate handler and add its typed case under the
actual transcribe affinity. Preserve existing pipeline case and tenant/refusal/
non-effect assertions. In the already scoped transcriptionTask.test.ts,
source replacement during prepare must preserve the captured provisional date
written by create; retain no prepare checkpoint, no normalized artifacts and
all source-replacement checks. Do not remove the provisional date in production
or accept an arbitrary timestamp instead of equality to its prior value.

For gh1593, authorize the existing API tenantIsolationJobs.test.ts only for the
missing valueLinksPropagate catalog case, using the actual registered handler
and correct tenant envelope. Do not mock the task or change affinity/catalog
exhaustiveness. If the active production rule catalog is empty, an honestly
labelled unknown-rule no-op case establishes registration/settlement only;
retain the separate real propagation/isolation proofs from the data harness.
It does not establish positive value propagation by itself, and grants no new
production rule, registry override, package helper or private import.

For gh1708, allow sempProblemsProducers.test.ts failJob to admit each fixture
through the real enqueueLibraryMetadataProcessing owner before processing and
expect the fixed safe failure. Preserve fetcher, problem count/dedup and tenant
assertions. The already scoped library.test.ts notification fixtures likewise
admit through that owner, assert pending and retain all notification recipient/
redelivery checks. The owner creates item_automation; direct processing without
that prerequisite is not a substitute for an admitted queued job. This is a
fixture correction, not a claim notification behavior is proven: if an actually
admitted job still fails these checks, return the production defect to parent.
No production notification or job-admission change is authorized here.

Duplicate gh1708 Touches entries were consolidated with the same union of Task
outcome, producer/sweep config guard and Task/config test scope. Original source
Task/AC and all six aggregate AC stay unchanged. Do not expose raw provider
errors to satisfy old test messages or weaken failure/privacy assertions.

Prepare one coherent test-only checkpoint, scoped lint/format and affected data/
API/transcribe type checks. Return exact diff and source/ledger attribution for
parent pinning before another runtime run. Do not rerun verify or integration,
launch E2E, change MCP environment/auth/transport/timeouts or alter CLI cleanup.
The MCP parser failure and mail DROP timeout remain unexplained. A later bounded
unchanged-file diagnostic needs a separate candidate-pinned parent plan; a later
success cannot explain the original failure or prove its individual DROP.
