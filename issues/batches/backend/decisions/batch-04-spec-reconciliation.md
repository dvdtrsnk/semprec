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
