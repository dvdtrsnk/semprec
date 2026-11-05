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
automation/error/privacy and gh1640 openQuestions/revision/atomic confirmation.
Fake only external providers, not the dispatcher, confirm owner or worker.
These permissions do not transfer between members.

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
persons and deduplicate self/participant by actual ID. Use existing title when
it is a string, otherwise NULL; add no People property.

With zero candidates do not call the model. Localized reason key
transcript.speaker.noCandidatesReason has en No matching people are available.
and cs Nejsou k dispozici žádné odpovídající osoby. For a missing/invalid candidate
answer use transcript.speaker.uncertainReason: en The speaker could not be
identified confidently.; cs Mluvčího se nepodařilo spolehlivě určit.
A valid model explanation retains its requested-language short text. Put only
these keys in existing transcription cs/en catalogs. Quotes are actual source
segments, up to three; use two or three when available, fewer when the speaker
has fewer utterances. Never fabricate or duplicate quotes to meet a count.

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
