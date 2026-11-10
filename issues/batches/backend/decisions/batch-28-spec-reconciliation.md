# Batch 28 specification reconciliation

## Initial owner paths and required evidence harnesses

The delegated controller approves these finite scope corrections. Source Task and Acceptance criteria and the six aggregate criteria are unchanged. This grants neither final verification nor acceptance. Per-member permissions remain separate.

- Gh1638 uses the delivered gh1567 owners mailThreadListQuery.ts and mailThreadRoutes.ts. Do not add duplicate mailThreadsStore.ts or mailThreadRouteHandlers.ts. Its existing mail/**tests**/ scope remains.
- Gh1633 changes default listing to inbox by its approved Task. In mailThreadList.test.ts preserve sent-only own-message and foreign-sent unread scenarios by explicitly requesting their existing sent folder; also assert those sent-only threads are absent from the inbox default. Keep aggregation, deduplication, cursor precision and tenant checks intact. Do not restore an unfiltered default, add a box mode, or weaken unread assertions.
- Gh1572 adds exactly mailbox list and mailbox detail entries mapping to packages/data/src/mail/mailboxRouteHandlers.ts in ROUTE_HANDLER_FILES, matching the real route matrix. Preserve exhaustive equality and write-boundary checks. Public surface may add only createMailboxListRouteHandler and createMailboxDetailRouteHandler, not internal readers. The existing exported imapConnectionLimitForProvider already supplies the shared lookup: reuse it rather than invent a second provider table or export.
- Gh1573 permits the exact public catalog entries for its Task-requested THREADS_MODULE_ID and runThreadsDatabaseCutoverMigration, plus only mail_threads index conventions affected by its specified nullable item_id migration. This is not permission for additional root helpers or a tenancy-policy change.
- Gh1574 permits the listed real recording intake, Files-trigger skip, authenticated streaming HTTP, existing isolated transcription producer and prepare/date test owners. Exercise an actual upload and consume its actual queued file through the production task with fake external gateways; direct intake/task controls alone do not prove the complete upload-to-transcript clause. Reuse the existing isolated producer/storage/resolver and preserve direct owned child exit/resource observation. Do not add a framework, reverse package imports or a live provider. Scope of fixture changes is only this composition, without weakening old controls.
- Gh1574 permits recording_requests in the existing tenancy catalog and runtime-role RLS table list/count (currently62, becomes63 if this is the only new table), its exact recording upload route mapping, and only Task-required upload/intake barrel catalog entries. Preserve all existing policy/default/composite-FK/privilege and foreign/no-scope checks. Add positive tenant data and foreign/random/no-effect controls in the scoped recording tests, not merely an empty table count. Use the real purge owner for purge evidence.

The new Threads hook's proposed-caller and nowait lifecycle question is not decided by these test/path permissions; it remains a separate concrete mechanism assessment. This record does not change hooks, relation admission or accepted ADR bodies.

Run cheap changed exhaustive contracts with coherent groups before R1, then the bounded R1/R2 process. No automatic full pipeline pre-pass, final gate retry, historical failure waiver or completion is authorized.

## Threads structural merge and catalog evidence

Apply ADR2026-11-05-mail-thread-item-merges-transfer-existing-relations. It is
an explicit internal structural handoff, not permission to forge ownerProcess,
update edge endpoints directly, bypass cardinality/hooks, or publish a merge
helper. RelationOps and RelationsStore receive only the specified transfer
mechanics. Mail remains the coordinator and checks thread/item bindings under
the existing guard. Preserve exact winner metadata on duplicates and source
metadata on new tuples, including references to existing trashed counterparts.
Delete-before-INSERT permits cardinality evaluation; every failure makes the
managed transaction rollback-only. The loser and failed-claim empty thread use
the ordinary itemDeleteWithClient owner and production action affinity. The
failed-claim compensation keeps a nonempty/adopted thread; it adds no physical
purge, alias cleanup, SMTP-I/O transaction or error-swallowing behavior.

For the nil proposed caller, skip only the Threads single-value caller lock/read
after exact property recognition; target/schema/ownership validation remains.
Real nowait callers reuse the existing value-link lock/error contract. Do not
change the hook registry or existing ordinary writers. Test both modes through
actual owners, concurrency/rollback and the stated structural cases.

Permit only Threads additions to libraryMailInboxModuleManifests.unit.test.ts,
moduleRegistryLoadAll.unit.test.ts and systemI18nCatalogCoverage.test.ts; keep
exhaustive equality. The existing alias and tenantForeignKeys fixtures and
mailIdentityPerTenant managed fixture may seed each test tenant canonically,
without weakening isolation/FK/alias assertions. mailSend.test.ts may prove the
real failed SMTP claim lifecycle and adoption control.

Canonical mail labels: database.threads.name = Threads / Vlákna;
property.threads.name.name = Name / Název;
property.threads.project.name = Project / Projekt;
property.threads.company.name = Company / Firma (en / cs). Identifiers,
comments and developer documentation remain English; localized catalog payloads
follow their locale as required by the existing i18n contract. No new icon,
ordering, client visibility or later Threads relation is inferred.

Only the data package build's mail copy segment may change to
mkdir -p dist/mail/i18n followed by cp src/mail/i18n/*.json dist/mail/i18n/.
Other segments, exports and dependencies remain unchanged except the separately
listed transcription copy segment below. Check actual compiled catalog bytes;
a source-only label check or Python imitation is not a build proof. The parent
selects any separate clean/repeat artifact obligation in the final plan.

The canonical seed always supplies Email's system project. A nullable type alone
is not evidence of a valid populated NULL-owner schema. The cutover may fail
closed with an invariant diagnostic when Emails exists but that owner is missing
or invalid; do not invent a project, select by name/first row, silently skip the
tenant, or rewrite unrelated ownership. Verify the referenced live Projects row
inside tenant scope. An absent Emails database remains the specified no-op.
Canonical populated/fresh/replay scenarios remain required; a genuine historical
NULL owner discovered at runtime needs separate explicit repair, not a false PASS.

## Recording intake and partitioned references

Apply ADR2026-11-05-recording-intake-coordinates-files-and-transcription. This
explicitly corrects the impossible item FK wording using the actual0118 owner
convention, and selects the bounded recording_busy/rollback-only protocol for
the identified blob/item inverse order. No new global items uniqueness, storage
shape, timeout, retry or pre-emptive fast transcript is authorized. Keep both
original accepted ADR bodies unchanged.

The new typed read of recording context needed by transcribe belongs to
recordingIntake.ts; it may be exported through the already-scoped data barrel
along with the required intake/upload variant, and listed in the exact public
catalog. Do not add unrelated helpers or exported error classes. Keep prepare's
current guards/checkpoint and read recording time from the data owner in the
write transaction. Explicit create-step Event wiring is still deferred1644.

## Named HTTP and shared read composition

Authorize the new API-owned mailReadRoutes.test.ts separately for gh1633 box,
folder/unread/mailbox; gh1572 mailbox DTO/status/privacy; gh1638 project/area/person;
and gh1639 query/operator/AND behavior. Use real authenticated createDispatcher
HTTP, runtime business pools and own/foreign/random/no-effect controls. Existing
reconcileGmailAccount testSupport can produce real mail; do not import private
data paths or invent root exports merely for setup. Keep data-level owner tests.

Authorize transcriptReadRoutes.test.ts separately for gh1576 detail/labels/
automation/error/privacy and gh1640 openQuestions and available HTTP confirm.
Fake only external providers, not the dispatcher, confirm owner or worker.
These permissions do not transfer between members.

The earlier HTTP revision wording exceeded the available transport. gh1870 owns
the absent revise route; HTTP revise remains DEFERRED / NOT RUN here. Prove
revise role restrictions and atomic People confirmation through the real scoped
data owner tests. Prove actual HTTP confirm on a production-created relation
card, plus the available HTTP openQuestions read. Do not add a revise route,
root/testSupport helper, private cross-package import, or synthetic HTTP revise.
This corrects evidence placement only; the source Task/AC and gh1870 boundary
are unchanged, and these separate controls are not an HTTP revise PASS.

For gh1576, listTranscriptSpeakers may accept an optional already-read typed
ItemRow from readTranscriptDetail, checking exact ID/canonical database/live
state and reusing its segment keys. Omission preserves existing behavior. Use
that same captured row to compose speakers, segments and speakerCount, and one
shared resulting label map for both arrays. No second transcript read, new root
export/facade method, wire field, cache, lock or isolation level. This provides
response-local segment consistency, not a global snapshot across other reads.
Test processing-to-published-segments overlap and later mapping label refresh.

## Speaker-card context, reasons and replay boundary

Gh1451 supplies generic JSON storage, not a speaker schema. Add only the concrete
Zod/type leaf transcription/transcriptSpeakerCardContext.ts for gh1640's stated
fields; no package/root export or generic context framework. Validate new cards
at write and stored context when it is used for an envelope-less speaker role.
Preserve legacy enveloped-card behavior and unrelated Event/Inbox contexts.
Use the existing authorized speaker/proposal tests plus the real worker speaker
step in transcriptionTask.test.ts, whose reason/null/locale fixtures and
checkpoint/no-second-call assertions are now separately scoped to gh1640.

Read invitationStatus only as a typed optional hint from the actual stored
Events.people metadata invitation.status: pending,accepted,tentative,declined;
missing/malformed/unknown is NULL. No new participant/invitation writer, schema
migration, authorization hook or early gh1757 implementation. Current free-form
metadata is not independently verified calendar invitation truth. Self not in
participants has NULL status. Keep the self Person even with an empty stored
name (name is then an empty string, not an invented identity); named-participant
filtering remains for ordinary Event candidates. Exclude already mapped/deleted
persons and deduplicate self/participant by actual ID. alternatives[].title is
always NULL in v1, as the original product decision requires. The earlier
read-existing-string wording was an unintended expansion and is withdrawn;
do not read or expose an incidental stored title or add a People property.
Existing scoped speaker tests may use a narrowly checked tenant/item historical
JSON fixture to prove an incidental string title is ignored; this is not a
supported production title writer.

With zero candidates do not call the model. Localized reason key
transcript.speaker.noCandidatesReason has en No matching people are available.
and cs Nejsou k dispozici žádné odpovídající osoby. For a missing/invalid candidate
answer use transcript.speaker.uncertainReason: en The speaker could not be
identified confidently.; cs Mluvčího se nepodařilo spolehlivě určit.
A valid model explanation retains its requested-language short text. Put only
these keys in existing transcription cs/en catalogs. Quotes are actual source
segments with at least six words, up to three: select the longest eligible
segments, then present them in time order and shorten each to 140 characters.
Available means eligible segments, not all utterances. Use two or three when
eligible; with one or zero eligible segments keep one or an empty quotes array,
even if many shorter utterances exist. Do not use short fallback segments,
concatenate, fabricate or duplicate quotes to meet a count. firstStartsAt still
uses the actual first segment regardless of quote eligibility. This clarifies
the original six-word rule without changing the source Task or AC.

Only the transcription build-copy segment changes to
mkdir -p dist/transcription/i18n followed by
cp src/transcription/i18n/*.json dist/transcription/i18n/. No other build rewrite.

No-second-model-call means replay after a successfully committed suggestSpeakers
checkpoint. Cards and checkpoint still commit together, and stored idempotency
keys prevent duplicate cards. A crash after an external response but before that
commit can repeat the model call; competing uncheckpointed snapshots have no
new exactly-once claim. Preserve existing production queue serialization, outside-
transaction model execution and checkpoints; add no distributed lock/receipt,
durable model-response protocol or hidden stronger guarantee. This boundary is
explicit in the revised source AC and remains an evidence limit, not a fake
universal PASS. Read-only issue inspection is allowed during metadata holds;
the prohibition concerns writes/staging/mutations, not local issue show.

## Prepare snapshot and competing Threads writers

The original recording ADR's visibility sentence was too strong with a
REPEATABLE READ write transaction. A Files row lock acquired after a wait does
not refresh that transaction's snapshot when intake inserted only a request.
Apply the separate accepted
2026-11-05-recording-prepare-write-rechecks-use-read-committed ADR: only the final
prepare write/recheck uses the existing default READ COMMITTED managed owner,
with an effective-isolation guard and unchanged item/automation/source/checkpoint
revalidation. Keep the first read phase REPEATABLE READ and every other worker
step unchanged. No Files timestamp touch, shared transaction API change, global
GUC, automatic retry or new production test hook. The old ADR body remains
historical; the new exception, source Context and actual execution evidence are
authoritative for this composition. Update only the existing prepare isolation
regression in transcriptionTask.test.ts to distinguish real read-RR/write-RC
transactions and preserve the no-SET-TRANSACTION guard. Real forced intake-first
and prepare-first cases must demonstrate the promised request/date visibility,
NOWAIT rollback and committed-checkpoint behavior, not merely count BEGIN text.

The original structural merge's discovered definition list cannot reserve an
unknown future insert. Apply the separate accepted
2026-11-05-thread-relation-writers-reserve-thread-endpoints ADR. Extend only
existing mail/threadValueEdges.ts and domainWriteHooks.ts so all supported
mutations incident on canonical Threads reserve the Threads endpoint, including
opposite-side and newly introduced definitions. Use existing write and delete
registries/modes; fresh locked liveness is mandatory for creation/replacement,
while removal keeps missing/trashed cleanup semantics. The merge's READ COMMITTED
post-item-lock discovery then sees a preceding participating insert; a later
writer must refuse a now-trashed loser rather than trust its old unlocked read.
Do not change generic API shapes or add a database trigger, global lock, timeout,
new admission API or retry. Privileged raw SQL/schema writers are not covered by
this hook claim. Existing-definition reservations remain useful for transfer and
cardinality, not a proof against unseen definitions. Force both actual writer/
merge orders and the new-definition case through the scoped runtime mail tests.

Gh1640 immutable speaker role belongs to proposal validation/confirmation and
openQuestions context, not a new presentation-kind promise. The existing gh1425
Task explicitly prioritizes needsClarification as clarify and transcript database
non-Events as clarify/page. Backend searches found no current caller of the pure
classifier beyond its own tests; this is static scope evidence, not a universal
dynamic-consumer proof. Leave inboxCardKind.ts and its unit harness unchanged.
Do not claim canonical speaker kind for the new People/context-only shapes.
Prove role-swap refusal, People/speaker atomic confirmation and openQuestions
through the already scoped actual owners. This preserves the existing canonical
status/fallback contract and adds no new frontend or stored classification.

## Threads generic relation transport evidence

For gh1573 only, authorize the existing API-owned genericOperationsContract.test.ts
for authenticated generic relation.put of Threads.project: store the first project,
reject a different second project with validation_failed, and preserve the first
edge. Use the real dispatcher, runtime business role, canonical seeded Threads
creation and own positive plus foreign/random/no-effect controls. Keep the
existing data-owner hook tests. This permission adds no endpoint, MCP evidence,
helper export, production dependency or unrelated fixture repair. Neither the
data-owner proof nor this REST proof establishes an unexecuted MCP path.

## Threads smoke catalog expectation

For gh1573 only, authorize backend/packages/data/src/**tests**/smoke.test.ts
to add the required Threads name to its exact seeded system database list.
Preserve exact equality, existing entries, keyed-database and system/schema-lock
assertions. No production catalog change, wildcard, reduced assertion or other
smoke fixture repair. This closes the obsolete test expectation found by the
actual full integration; original integration054 remains FAIL on its SHA.

## Transcription composition card identities

For gh1640 only, authorize the existing transcriptionGatewayComposition.e2e.test.ts
to reconcile its obsolete single sourceTranscript-edge expectation with the new
mandatory speaker clarification card. Assert exactly two distinct canonical
Processing proposals sources for this fixture: the proposed Events database
envelope and the envelope-less needsClarification SPEAKER_00 card with validated
speaker context. Inspect actual typed row payloads; do not filter away extra
edges or merely loosen the count. Preserve worker/gateway/finalization/tenant
and realtime checks, and assert each source card receives its own relation
invalidation while retaining the existing inverse-transcript invalidation.
No production, provider, fixture-output, timeout or lifecycle change is granted.
