# Batch 25 accepted-base scope reconciliation

Owner-delegated controller thr_pz39tcih5r selects these exact contracts at the
independently audited batch24 completion 185a9300ad28fe014fe03ad821acce4e6448dc78.
The read-only design proposals are advisory inputs, not runtime evidence or an
independent review. No prior candidate exceptions transfer.

## Module MCP actor and common owner

Gh-1580 follows [[2026-11-04-mcp-exposes-module-agent-tools]]. Initial module
exposure requires an actual restricted run actor, safe none classification,
current run-project admission and credential/process intersection. Human
generic MCP is unchanged; run-only module tools are absent for humans and
non-core module capabilities remain unrepresentable by current credentials.
This explicitly narrows initial exposure rather than inventing a human run,
new grant store, actor framework, approval kind or credential format.

Extract resolveModuleAgentToolsForRun to the data-owned agentTools module and
reuse it from agents and API. Keep native SDK and MCP wire formatting in their
own services. Validated returned errors use MCP isError; thrown domain errors
retain the specified mapping. All active declaration names participate in
generic-name collision detection, including hidden/gated tools. Registry
scope covers this name projection only. The five exact external MCP fixture
paths may maintain the required listener signature/wiring, preserving their
existing behavioral assertions. Public surface changes are exact required
exports, not a blanket barrel expansion. Accepted ADR bodies remain immutable.

## Voice vocabulary and single owner

Gh-1546 uses the original start(language, optional thread id), stop and end
controls and ready, transcript, speaking, error and end responses. Remove the
contradictory mute/unmute/closed vocabulary. Follow
[[2026-11-04-single-owner-voice-channel-admission]]: one channel in serve.ts,
one supported voice-owning API process, per-user admission/release, existing
tenant listener, late-auth closure, session revalidation and bounded shutdown.
Multiple voice-owning processes are unsupported; no distributed admission
guarantee or new lease store is implemented or claimed. This is a supported
deployment restriction and must remain visible in the handover. No voice
module-deactivation mechanism, provider, speech, thread/turn cancellation,
client implementation or listening qualification is included. Gh-1734,
gh-1396/1399 and the production gate retain their ownership.

## Search and reindex ownership

Gh-1589 owns the shared vector/query/phone shape and full non-Emails reindex
at every successful deploy, retaining body/page_text. Add phones to the explicit People searchFields
and update the former negative contract to actual normalized-phone positives.
The missing-only and full generic backfill keys already differ; preserve them
and the ordinary missing-only helper default for other callers. Do not replace Emails rows here.

Gh-1591 owns new mail ingest text. Gh-1741 alone owns full existing-mail rebuild
and one deploy enqueue after queue readiness, including transition deploys.
Expose that same enqueue owner for later activation. Existing Graphile replace
schedules a successor behind a running same-key job, while pending work
coalesces; use stable global named queue mail-search-text-reindex to prevent overlapping full rebuilds.
Do not use unsafe_dedupe, change the queue wrapper, or modify the legacy
missing-only mail sweep. Test held-running replacement through the real worker.
Preserve active-tenant mail traversal versus maintained-tenant generic traversal
as their separate Tasks specify. Existing CLI and job-classification paths are
added narrowly for the actual wiring and runtime-role fan-out proof.

## Scope and execution

Member source records and exact embedded snapshots are updated together through
normal approval guards. The aggregate's redundant top-level Touches union is
replaced with a reference to the exact member lists; this grants no broad
directory permission or cross-member scope. Required public-surface expectations
and the Journal write-route boundary mapping are authorized per member only.
All other Tasks, AC, order and external prerequisites stay intact.

Reconcile existing source before building it. Run cheap changed-contract checks
early, particularly public surface, write safety, boundaries and exhaustive
route/task catalogs. Group coherent development validation; do not modify
source while claiming a fixed-byte run. Use one complete R1 and one focused
same-reviewer R2, then direct parent closure. The final plan runs one unchanged
verify and reuses its actual completed phases, with separately selected extra
artifact obligations or unreached tiers only. Seed catalogs already use flat
copy: preserve the build segment and prove current new-label clean/stale/repeat
parity in owned staging with the retained driver. No implicit native/package
sweep or new monitoring framework. Routine scoped type/lint/fixture repair is
autonomous; concrete new scope or architectural conflict is grouped for parent.

Local-only feature/backend-delivery integration remains separate from release.
Gh-1086 stays byte-identical OPEN/BLOCKED. No push, deploy, live account/provider,
web/mobile work or environment teardown is authorized.

## Existing mail vector writer

The actual reindexItemSearch in mail/search.ts owns one INSERT/upsert used by ingest and rebuild. Gh-1591 and gh-1741 now explicitly permit the combined czech/czech_simple vector there, not a new writer or an early gh-1589 Emails rewrite. Preserve query/rank/operator code and the legacy sweep itself; its future writes naturally use the same common writer. The full-reindex unchanged AC also requires unchanged vector/database upserts not to rewrite updated_at; a guarded conflict update supplies that no-op without changing genuine vector writes. Prove both changed-vector and unchanged-vector behavior in the already named ingest/reindex tests, including updated_at/xmin repeat identity where relevant. No separate test matrix, public export, query rewrite or generic indexing sweep is authorized.

The phrase existing named queue means reuse the existing Graphile facility, not a preexisting business queue. The new system task uses stable global queue name mail-search-text-reindex for both current and successor executions; normal replace keeps its successor behavior. Do not reuse a tenant lane for a system-wide fan-out or create a new lock/queue subsystem. Source and aggregate specifications are reapproved coherently; no accepted ADR body changes.

## Preserve page projections and recover interrupted deploys

The initial DELETE instruction in gh-1589 is unsafe for the current0120 projection columns: backfill reads page_text from the very row deletion would destroy. The approved migration now creates czech_simple without deleting index rows or clearing body/page_text. It does not take over gh-1658 page conversion. Existing full non-Emails backfill preserves those columns while recomputing vectors. Every successful deploy enqueues that full pass after queue readiness, with existing coalescing/full key and bounded tenant/page execution. This deliberately accepts a full bounded pass per deploy, avoiding a new receipt/generation store and ensuring the next successful deploy retries prior activation/schema/enqueue failures even when activation already committed. The previous transition-only enqueue plan is replaced; missing-only helper defaults and existing distinct keys remain for other callers. No automatic retry of a failed deploy is claimed.

Gh-1741 follows its non-deleted traversal and existing trash lifecycle. Its conflicting AC is explicitly reconciled to search-visible exclusion: soft-deleted mail is not returned from real search, while a retained index row is left unchanged until normal hard purge. This preserves attachment projection for restore and avoids adding a derived-row cleanup, new restore hook or locking protocol. Test a genuinely ingested/indexed mail then production soft-delete, job, actual negative search with positive live control and preserved row; restore retains prior attachment search. Do not present skipped-deleted behavior as physical removal. The existing mail writer handles repeated identical vectors atomically, not a stale job-side precheck. No accepted ADR body is changed.

## Live mail visibility and available body

The actual searchItems uses a LEFT JOIN without a live-item predicate. Gh-1741 therefore narrowly admits its real same-database non-deleted item filter, retaining query/rank/operators. Its exact czechHunspellSearch and mailSync harness permissions replace phantom random index IDs with real Emails items while retaining current behavioral assertions; no blanket search-test rewrite. Ingest currently stores HTML preferentially but indexes text/plain preferentially. Historical rebuild uses the available stored body, converting HTML as specified; it cannot reproduce a divergent discarded text/plain part. No ingest persistence redesign or exact historical multipart parity is claimed.

## Required filename match

Gh-1589 explicitly requires faktury to find Faktura_2026-10.pdf, but PostgreSQL treats that filename as a file lexeme. The existing generic document owner may retain the original Files title/name already admitted by searchFields and append its letters/digits-tokenized copy. This is limited to that Files title, preserving original text and other property projections, body/page_text, vector/query/config semantics and searchFields admission. Prove the actual Hunspell + real Files write/index/query hit, prefix control and unrelated-file negative in already authorized tests; preserve the original failed development run. No new owner, public helper or architectural pattern.
