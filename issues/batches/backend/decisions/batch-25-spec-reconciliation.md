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
after false-to-true activation. Add phones to the explicit People searchFields
and update the former negative contract to actual normalized-phone positives.
The missing-only and full generic backfill keys already differ; preserve them
and the ordinary missing-only deploy default. Do not replace Emails rows here.

Gh-1591 owns new mail ingest text. Gh-1741 alone owns full existing-mail rebuild
and one deploy enqueue after queue readiness, including transition deploys.
Expose that same enqueue owner for later activation. Existing Graphile replace
schedules a successor behind a running same-key job, while pending work
coalesces; use one existing named queue to prevent overlapping full rebuilds.
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
