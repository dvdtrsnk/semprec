# Parent adjudication — batch 04

Authority: explicit owner delegation to thr_pz39tcih5r for autonomous backend program decisions. Read-only origin/validation architecture analyses supplemented direct working-tree inspection.

- gh-1486: page/journal confirmed-block authorship remains owned by gh-1681/1981, whose exact Tasks and AC already require user authorship. Preserve current single-step behavior and the accepted page-policy ADR's documented interim divergence; current acting-user item writes remain mandatory.
- gh-1390: preserve gh-106's independent source-change/read-phase Journal refresh. Stale skips add no card-write-phase enqueue or card write; tests must distinguish the triggers despite day-key job coalescing. No trigger relocation is authorized.
- gh-1479/1486: repair graph/validation/write consistency across effective after.relations and changed-key coverage. Reuse actual read-only choke-point property validation. Confirm guards before values in the write transaction with precise ref/field errors and atomic rollback. Item locks alone do not protect relation phantoms: use the existing definition advisory keys and incident-edge row locks with documented deterministic ordering. A scoped new ADR and real overlap tests are required; historical ADRs remain unchanged.
- gh-1659: no exact immutable historical item/card creation timestamp exists. Surviving proposal history may restart and updatedAt is a revision timestamp. Authorize nullable capture time and explicit inboxCapture/unknown/legacyUnverified basis, a new additive migration and scoped ADR. Preserve legacy values without certifying them; do not fabricate creation time, backfill guesses or expand the generic items schema. Missing Inbox time has the same honest unknown treatment. Actual-row export/purge evidence is required.
- gh-1967/future batch 70: propagate nullable time and basis to the eventual origin API now, without implementing or dispatching that endpoint. Batch70 remains unapproved.
- gh-1358: actual user locale is passed unchanged to computeProposal, except null -> cs; cs/en catalog normalization stays separate. Add fr evidence.
- gh-1716: real confirm-to-Files-query and production-page query-count checks replace helper-only evidence; the existing recovered test path is explicitly in scope.

Only redundant aggregate introduction/Touches annotations are compacted; other approved Task/AC contracts remain.

- gh-1486: d77bbc5f9f07fdf937c4b30fdf604baeff02cd6b083febb5922bc69ea134c583 -> 279a5a6a70e7ca68126226d08ef2c0068494bd857fbb1f6eeb17ba704a054601
- gh-1390: b1bf91315975d91b1de2be84305355f8cb85c7d2cfb6c52afa9c4d69c435d07b -> 7bf8ffb8fc3350199118b9b717182c56277454f20c0696b7e99c28c2b1a63cd6
- gh-1479: 647683a4712f26f484c3f6649458c0a87fd7e9178d087236f9fb8772f1c02549 -> c993004e9c163a8bcada4a19a1f3ff3edb20e40a646f65e2bdb43ad96bdbdf6d
- gh-1659: 8cc07c2bdf31581971eabe2982c5092ee082bda2a6a59ea232e599b4a27f0f93 -> 77f07bc012df280f6dae959d2ec1a348d13e43fc2155004f75d0e03c7c8be002
- gh-1358: d253df9080448163e86be46b6dfb85a4a53bb95e74ac48cb33b40243f147dcc4 -> 376371cc3aab71e9b55e645a8374c87255220eb03aadd2522d2f29e2ac58b219
- gh-1716: c20b843f2b1fe3be890e0f16ae4945b973d6406a46413ca94dd68108678e4207 -> 248454e103798cd6475805d60e9c24fde1157d0acd804668357c22fc742498c6
- gh-1967: 21adcf3eaeb4f46e6aa03844c7d58618d56deaa1588e753b0e74fc935a6a49ce -> 0c1123ef485fb2aa135c930037cfcf183bde28815b5bc520ba7b7362275dcc66

## Registered preparation and stateful Projects allocation

Independent review found that title/color-only checks omitted real Tasks schedule validation and transform-added user-owned time clears. Direct inspection also disproved the initial blanket assumption that every write transform is a pure preview: Projects takes an advisory lock and allocates pinnedOrder as MAX+1. This decision supersedes that initial assumption, without changing historical accepted ADR bodies.

Authorize a read-only registered preparation seam alongside write transforms, composed for the existing Tasks, Books and Projects modules. Share deterministic rules with the actual write path; no domain dispatch in the generic choke point, allocation, mutation hooks, write probes or Projects allocation lock in preflight. A registered transform without safe preparation fails proposal validation closed; ordinary direct writes retain their behavior.

Caller fields and deterministically changed transform-added user-owned fields require matching before/after coverage. System-derived outputs are excluded. Confirm prepares against the locked row and checks every declared before key even if the current transform would make it a no-op. Incomplete legacy multi-step snapshots fail with 400 and precise ref/field, leaving the card proposed and all writes rolled back.

Projects.pinnedOrder remains user-owned. A trusted module declaration may defer its implicit automatic allocation: before.pinnedOrder is mandatory, numeric after may be omitted, and the real choke-point write receives the original caller patch and allocates once using the existing item-then-project-advisory lock order. Concurrent pinning of another project may legitimately alter the allocated number. Explicit caller values require ordinary matching before/after; conflicting redundant after values fail. Automatic destructive clears, including Tasks time fields and project unpinning, receive no allocation exemption.

Extend this batch's new confirmed-proposal-update-preconditions ADR with the seam, rationale, deferred-key exception, compatibility limits and exact lock ordering; older accepted ADR bodies remain immutable. Require real registered-transform schedule, implicit-clear, stale-field and deferred-allocation regressions plus full remaining independent Task/AC review. This decision does not claim a review or verification PASS.

To retain the aggregate's 60000-character bound, historical explanatory Context prose, tier rationales and redundant aggregate introduction are compressed without changing model classifications; decisions and Task/AC are retained except for the explicit gh-1479/1486 clarification above.

- gh-1479: c993004e9c163a8bcada4a19a1f3ff3edb20e40a646f65e2bdb43ad96bdbdf6d -> 1f128ea22f04ef564578c6346081e397d827f01a654f8894115e0f72e882c4cf
- gh-1486: 279a5a6a70e7ca68126226d08ef2c0068494bd857fbb1f6eeb17ba704a054601 -> 923c2df25d7f053ac1c2a90dc752215705b656bd8a268d3381d2951c4a5820ae
- gh-1358: 376371cc3aab71e9b55e645a8374c87255220eb03aadd2522d2f29e2ac58b219 -> 3b8acea3771e7da7f1f322cffccc679fbad8a82a0bbdb9a96ccad0b3b73ee45b
- gh-1716: 248454e103798cd6475805d60e9c24fde1157d0acd804668357c22fc742498c6 -> a157115bb160f7c4065423763809ff15e9447e04e8a90a6778f5eeee04567251

## Deferred allocation has no predicted after value

Clarify the earlier ambiguous "may omit" wording: implicit Projects allocation MUST omit after.pinnedOrder; every predicted after value is unsupported and returns 400 with the step ref and pinnedOrder field. Its before value remains mandatory and guarded. Explicit caller-supplied properties.pinnedOrder continues to require matching ordinary before/after. Do not silently ignore or imply validation of a guessed server allocation. This does not change the allocation algorithm or ordinary write behavior.

- gh-1479: 1f128ea22f04ef564578c6346081e397d827f01a654f8894115e0f72e882c4cf -> df2c6a0d990e81554ac9886762f36236840aa6df0200830fbf89f96e1c617774
- gh-1486: 923c2df25d7f053ac1c2a90dc752215705b656bd8a268d3381d2951c4a5820ae -> f7ea9e8da3007555cfc49d06b0c2a436e000647a391f4c8add6764cc2b4d2ec8

## Inbox-origin flag reaches actual HTTP responses

Direct inspection confirms the API toItemEnvelope mapper reconstructs an ItemRow and drops its existing optional fromInbox. gh-1716 Task 1 already requires that flag in item reads and database/view queries; data-layer tests alone do not demonstrate this boundary. Authorize the minimal optional envelope field/forwarding when defined, without any adapter origin lookup, preserving existing write omission and all other envelope fields.

Add actual authenticated HTTP single-item and database/view query tests with real proposal confirmation and a manually created Files comparison. Keep set-based production page/query-count, deleted-origin and tenant isolation evidence. Scope includes the mapper, the three existing handler test files and one optional shared typed origin fixture. No client implementation or origin filter/sort is included.

To respect the aggregate's body limit, only gh-1417's historical descriptive Context paragraph is compressed; its decisions, model tier, Tasks and AC are unchanged. Review-02 remains BLOCKED/incomplete, and graph-pruning, relation-only preparation and real populated-tenant migration-runner evidence still require fixes and full independent review.

- gh-1716: a157115bb160f7c4065423763809ff15e9447e04e8a90a6778f5eeee04567251 -> 435eb504160c452cf5fbeafec6e61d89a3f03a4284b825855c4366552c5a73c9
- gh-1417: 6c0555302299218e3c9f127db3124ca67649136ce7d6b98e1a18ef1ee52225f9 -> 3e80b597e9c4bd7a1d85c869fda752d0ef5bae4d2198cd172c68624bc81f8716

## Unknown-kind conflict identification on the HTTP boundary

The global HTTP error envelope intentionally excludes internal exception messages. For gh-1419, retain the internal descriptive conflict message, HTTP 409 and existing error code/envelope; add the primitive entityKind alongside field in conflict details. The public identifying information is details.entityKind, not a new general message field. No global adapter change or new route is authorized. Add the authenticated HTTP confirm regression to the already aggregate-approved itemsHandler.test.ts, now explicitly included in this source Touches. Assert exact details and unchanged proposal/target state; retain revise evidence at its existing data entry point.

Only the historical introductory Context paragraph is compressed to retain the aggregate body limit; the rollback sequencing decision and all other Task/AC remain.

- gh-1419: 337af8821395a0c6aef1f32f864669a1ca3d79dcd14ec721f51db4a6b90f27f6 -> f511cad62c9a37eef42e9e820585a2a9b8b5e96c36cf6f2795adc7e8760e18a2

## Global step identity, transcript ownership and retained edges

gh-1479 keeps global nonempty/unique refs and exactly one primary even for skipped steps, consistent with the accepted multi-step ADR's identity contract. Skipping waives payload/outgoing-target validation and writes after pruning, not global structural identity. Test disabled/unreferenced empty/duplicate refs separately from skipped malformed payloads; preserve active required-reference errors. Historical accepted ADR bodies remain unchanged.

gh-1425's required ownerModuleId string-or-null input keeps null as unknown, not unprovided. Transcript database envelopes produce transcriptEvent/base event only for Events; null, unknown and known non-Events owners produce clarify/base page. Invalid status still overrides cardKind and retains derived base. Known transcript relation event/speaker roles keep their existing derivation with null owner. Do not add an undefined ownership state, new storage access, list route or transcript write authorization. Only historical descriptive Context prose is compressed; all other decisions and Tasks/AC remain.

Caller before lists never authorize skipping target guards. A real retained edge can exempt its own same-caller/definition/target pair only from the new-edge cardinality collision. All existing tenant, existence, deletion, archived-target/database, ownership and hook guards remain. Authorize narrow caller-aware validation in the existing chokePoint/relationOps.ts, with retained-edge positive and invalid/foreign/deleted/archived-target evidence. Updates continue to lock/compare every declared before relation; link preflight validates its actual targets. No write probes or global cardinality redesign.

The gh-1390 source-edit -> locked/no-card-write tick -> real day-worker updated-text scenario is already authorized; do not relocate the independent source/read trigger. Review-05 findings and missing link execution/rollback/retry evidence remain blocking pending fixes and full review.

- gh-1479: df2c6a0d990e81554ac9886762f36236840aa6df0200830fbf89f96e1c617774 -> 4632c6e063bf5685f35acfa9a1ef85b6014f21b73d6912379d83098902452ebf
- gh-1425: 6a0a2d88f30185946fcad83919e6b691fc5ed2fcde720d0407d3cb5afd1d44e0 -> 40dfb2687c3329e3149963acfdf88264fe8a3e79e85fc417da8b2fe4cec227f6
