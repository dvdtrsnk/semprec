# Batch 30 — page capability and evidence-owner reconciliation

Owner-delegated controller decision for aggregate
`sp-c7d74d78-a59f-4453-b2d6-3c9c31f8b235`, based on accepted batch 29 completion
`b43a3c0a43fb020becbf673150667e5e1d51f767`. This applies existing architecture;
accepted ADR bodies remain unchanged. Local acceptance exceptions from batch 29
do not transfer to batch 30.

## Page operations

Follow `docs/adr/2026-10-28-page-operation-family.md`, section 3:
`page.get` requires `core.page.read`; `page.ensure` requires `core.page.write`.
Register both capability identifiers in gh1615. Existing item-only grants must
not acquire either capability implicitly. Preserve the existing human-session
composition from registered module capabilities; do not add agent grants,
credential migrations or the policies deferred to gh1400/1844.

The already implemented `page.restoreVersion` currently uses `core.item.write`.
Correct that single metadata entry to the ADR's `core.page.write` while retaining
its destructive classification and approval flow. Prove discovery and refusal
for item-only grants and continued explicit page-write authorization. Do not
register any other unimplemented page operation.

ADR section 1 assigns exact response schemas to the implementing issue. Thus
gh1615 keeps its flattened `lastEditedAt` and `lastEditedBy` fields without a
second `lastEdited` alias. Consume the delivered gh1405 DocRow, including its
document-created-at fallback and nullable author; no document means null edit
fields. Count actual root blocks before limiting, excluding the synthetic empty
block. Count existing page blocks and expose their existing pageId without
implementing subpage creation or its deferred ancestry model.

The conditional gh1615 placeholder predates delivered gh1608. Consume the
existing canonical inline Markdown conversion for block text and h1-h3 headings.
Export the existing `serializeInline` implementation from block-model through
its barrel, with its algorithm unchanged. Do not duplicate conversion logic or
implement the deferred full Markdown page response. Existing inline database
ancestry uses `getItemPath`, with Journal type/period metadata; unsupported
subpage ancestry stays null until gh1676/2014.

Read-only document summary belongs to the existing data/docs owner behind its
public factory; no application SQL or private cross-package imports. It must
not use a read path that compacts or writes. Page ensure uses one managed
transaction through that same owner, reserving/rechecking the live item before
getOrCreateDoc even when the document already exists. Preserve unrelated callers
of getOrCreateDoc and the existing wrong-kind conflict. No new global lock or
isolation protocol is authorized.

## Existing owners and finite test scope

Per-member Touches lists include the exact existing REST, MCP, agent and closed
catalog harnesses required by their named scenarios. Permissions do not transfer
between members. Tests must execute actual dispatch/owner paths with the
production runtime role and owner-positive, foreign/random and no-effect
controls where applicable. Catalog assertions retain exhaustive checks; no
filtering out new entries or weakening safety scanners.

Gh1583 may export only its requested active-session reader. Gh1584 may extend
the actual schema and generic-property HTTP harnesses for color behavior.
Gh1586 keeps completion inside the existing Projects transaction transform,
omitting its implicit system-derived completedAt from client-free preparation
and retaining ordinary owner refusal/preconditions/replay. Its HTTP/MCP cases prove the same
response and localized property projection. Gh1997 uses the actual deletion
and query transports to verify the system-area marker without changing its
existing deletion protection or introducing statistic behavior.

Gh1587 preserves the existing item-before-link reservation order and existing
value-link owner/propagation semantics. The historical count of 29 is replaced
by the current base count of 32; add exactly two operations here and one in each
page member. Closed contract files and route/public export catalogs may change
only for each member's sanctioned entries and scenarios. No propagation rewrite
or new cross-domain registry is authorized.

## Evidence and release limits

The batch30 advisory was pinned before batch29. Parent compared all 80 recorded
mode/blob identities at the accepted base: 75 unchanged and five changed
(tenant cutover registry, generic port/rows/schemas, REST contract test). The new
gh1575 handover is read separately. This is static preparation, not completed
worker intake, a new test result or release certification.

Retain the original six aggregate criteria, source Task/AC provenance and every
actual FAIL/NOT RUN. Use one complete R1 and one same-context focused R2, then
parent disposition. A final verify plan must pin the actual coherent candidate;
do not pre-run a second full pipeline. No production rollout, live provider,
push, environment retirement or change to gh1086 is authorized.

## Gh1578 existing People fixture compatibility

The existing peopleRelationshipOptionsCutoverMigration.test.ts calls the full
registered runner and compares its output with a fresh seed. Gh1578 necessarily
changes that resulting order. Authorize only its required target-order assertion
and corresponding fresh-seed comparison alignment. Keep the old-order synthetic
input, full equality check, preserved option metadata, added-key write controls
and repeated-run idempotence. The test that invokes only the original People
option-extension owner keeps its existing order-preservation expectation. No
production behavior or source Task/acceptance criterion changes in this delta.

## Gh1586 system-derived completion and exact process owner

The initial instruction to defer system-owned completedAt was incorrect. Apply
[[2026-11-05-task-proposal-preparation-defers-implicit-completion-day]] and
[[2026-10-31-confirmed-proposal-update-preconditions]]: deferredKeys represents
user-owned implicit allocation; system-derived keys do not enter user before/after
preconditions. Projects preparation omits its implicit clock-dependent completion
value. Its real transform computes that value within the existing managed write.
Do not extend itemWrites.ts or weaken its deferred-key/caller-owner checks.
Existing pinnedOrder/date user-key preparation and stale-before checks remain.

The exact registered transform module is projects, not systemDatabases. Under
[[2026-10-29-item-pre-write-transforms-per-module-registry]], a non-null system
ownerProcess on a transform-added key must equal that module id. Pin the
completedAt owner constant and property to projects in fresh seed and the
authorized cutover. Do not add a parent-module bypass, change transform registry
semantics or repair unrelated fields. No committed completedAt implementation
exists at this decision; in-progress uncommitted declarations must follow the
corrected source. Test actual proposal formation/confirmation without predicted
completedAt, direct caller refusal, ordinary user-key preconditions and retained
Tasks behavior. Existing ADR bodies, source AC and the six aggregate AC stay
unchanged. This decision applies their existing rules, not a new architecture.

## System-area refusal follows each existing transport

Gh1997 requires the same actual refusal and live-item preservation through all
three transports. Its literal common HTTP403/field requirement is corrected to
the existing envelopes: REST HTTP403/details.field systemActive; authenticated
MCP HTTP200 with JSON-RPC -32000, data.code forbidden and
data.details.field systemActive; AgentTool error true with its existing
forbidden-prefixed result and no approval request. The latter does not expose
status or details.field, so do not attribute lower-layer values to its output.
Follow [[2026-09-18-mcp-json-rpc-transport-for-the-generic-operation-catalog]].
No adapter, error schema or destructive-projection behavior changes. Test actual
transport calls and unchanged item, not a substitute owner-only call. The first
provisional parent message incorrectly named MCP -32001/direct data.field; that
is the approval-required envelope and was corrected before this refreeze.

## Relink transition stays with the existing SQL owner

Gh1587 may add one checked tenant-scoped reactivation method to valueLinksStore.ts
for the existing link reserved by valueLinkOps. It returns the row to on and
clears broken_by/broken_at within the same caller transaction as the value write.
Use existing row-result validation and affected-row checking. Keep SQL out of
the new operation coordinator, do not export the helper from the public barrel,
and introduce no lock, source rewrite or propagation behavior. Existing actual
relink/rollback/no-effect tests remain the evidence owners. Per-member permissions
and the six original aggregate criteria stay separate and unchanged.

## Registration is separate from automatic project-agent grants

Follow docs/adr/2026-11-06-page-capability-registration-does-not-grant-project-agents.md. Register the two page identifiers in schemaCore
for existing human-session MCP composition; narrow only the existing project
permission-manifest computation to exclude those exact automatic core grants.
Keep both identifiers in the core set so the non-core module loop cannot
reintroduce them. Retain other core grants, current module ownership rules and
credential checks. No new grant state, administration API or early page policy.
The existing manifest and persisted-run AgentTool harnesses prove exclusion,
no module regrant and no document/approval effects; direct gateway tests with
explicitly supplied page grants are separate binding evidence. Legacy item-only
agent access to page.restoreVersion is not grandfathered. Human MCP page
discovery and calls remain supported. Old accepted ADR bodies stay unchanged.

## R1: page.get rejects a document of another kind

The page-family summary describes kind page. An existing canvas is not an
empty page. Gh1615 rejects it through the existing ConflictError, status409
and code version_conflict, without converting, creating or changing any
document state. PageSummary.kind is the page literal. Keep the documented
no-document success unchanged and retain the existing ensure wrong-kind
conflict. REST returns409; MCP uses its existing HTTP200/JSON-RPC -32000
conflict envelope. Already scoped actual HTTP/MCP harnesses must prove the
refusal and unchanged document. No new error code, adapter, persistence owner,
lock or accepted ADR edit is required. This pins the implementing issue
contract under the page ADR, rather than expanding canvas behavior.

R1 on48e09b0 remains changes required and immutable. Bundle this repair with
the other confirmed R1 test/evidence repairs, then use the one remaining
focused R2 in the same reviewer context. No third review or final gate is
authorized by this metadata decision. The six aggregate criteria stay unchanged.

## R1: fixture-configured relink propagation evidence

Only gh1587 valueLinkOps.test.ts may reuse the existing linkRulePropagation
fixture seam: construct a real ModuleRegistry from the existing
linkRuleValidModule and required real manifests; replace only
loadFullModuleRegistry with a restored spy. Install it before the first rule
catalog read in that isolated test-file module lifetime, restore the loader
in cleanup, and introduce no production cache reset/export or shared cache trick.
The real relink owner, linkRuleItemHook, SQL queue and registered worker execute
unchanged. Observe actual downstream work and resulting state, including rollback
without escaped work/invalidation. Do not mock those execution owners.

This is an explicit exception to the worker prompt provider-only injection rule
for configuration supplied by an existing test loader. It authorizes no change
to production manifests/rules, propagation code, dispatchers or registry loader.
The current built-in registry has no linkRules declaration; report these results
as fixture-configured integration evidence, not proof of an active production
rule. Existing runtime-role, tenant and no-effect requirements remain. R1 report
and reviewed ledger stay immutable; one same-context R2 remains after repairs.

## Verify051: existing contracts and direct docs catalog packaging

Original full verify on051 remains FAIL: six tests in five files,7135 passed,
one skipped. The unchanged MCP inherited-environment assertion is retained,
without source/environment modification or automatic acceptance exception.

Authorize four existing compatibility harnesses only: genericOperationAgentTools
keeps exhaustive coverage of every still-granted operation and explicitly excludes
exactly page.get, page.ensure and page.restoreVersion under the approved default
project policy; do not mirror runtime metadata as a self-fulfilling oracle.
Area write-query tests retain the same active/sort inputs and assert the seeded
system area plus the original user-item order; do not hide it through production
filter changes. Areas property-cutover tests preserve the one existing system
area and prove the cutover creates no additional item. Views retains exact Czech
label, monitoring filter, stored-view/property and item invariance assertions,
adding only the independently specified monitoring color #FF9500.

The successful build copied matching docs catalogs one directory too deep while
leaving stale direct runtime catalogs without page.notes.title. The compiled
pageSummary loader resolves the direct path. In data/package.json replace ONLY
the docs recursive-copy segment with the existing mkdir/flat JSON copy pattern,
refreshing direct dist/docs/i18n files even when destination already exists.
Do not change other asset copies, compilation/dependency versions or loaders.
Prove on the repaired candidate with one data build and direct cs/en parity;
any repeat-refresh control uses exact owned scratch catalogs and the same copy
segment, not another broad build or modifications to tracked sources.

Parent directly inspects the finite delta after worker self-review. No third
review, full verify rerun, E2E, acceptance or integration is authorized here.
Original review verdicts, preflight NOT RUN, actual verify FAIL and queued-job
rollback UNPROVEN remain. Source Context redundancy was compacted without
changing Task/AC behavior, source AC or six aggregate AC; no limit/checker changed.
