# Parent adjudication — batch 02

Authority: explicit owner delegation to parent thr_pz39tcih5r for autonomous project decisions.

- gh-1414: recognize the existing standalone accepted converter-context ADR and prior decision a8bcf732. Do not rewrite the accepted two-pass ADR.
- gh-1427: retain the intentionally empty module. Verify registry activation and absence of contributed databases/tools/routes; do not invent module-list/route-list fields outside this issue's Task.
- gh-1459: the requested two-column items FK is not expressible without the partition key. Retain the users tenant FK and applied migration; require a same-transaction, row-locked, tenant-scoped Projects attribution guard with negative/no-write tests and a scoped ADR. This is an explicit integrity mechanism change, not acceptance of the old handover's omission as compliance.

The source requirements and aggregate were revised, reapproved under delegated authority and included in the canonical manifest. Execution must refreeze against this commit before resuming. No production code changed in this decision.

- gh-1414: 783d5d197b3fbccec89902272a114b7125bbf0c397e5d1b29f72b7664dc65d22 -> 34e7b7ce3760ad9284f5f9b0c6f67255b5bc1e01eeec62524ffab5f3045b0dd7
- gh-1427: 9b6720159991c5997a99ce65b5b706359c0417b04b3240bad7d93bf4d101e90e -> b0cd0f1d573b358eb40b0e0608474f5e04f98eb751a4b5eee0e902e3b566addb
- gh-1459: 08799f92d266790b7e5ab00b0874b7f2aac066857b234d19afb6469537942e3c -> 71a2254f0df58f303b82fc487adac3b0862a1d00e3b5499930693d37e42ea5d6

## Runtime-role and compatibility follow-up

- gh-1459: SELECT FOR KEY SHARE needs privileges deliberately absent from semprec_side. The parent chooses a third option: attribution is a tenant-scoped EXISTS predicate in the conditional INSERT/UPSERT itself, with checked no-row rejection. Both existing roles remain supported without a grant, SECURITY DEFINER helper or separate pre-check. The ADR must honestly describe statement-snapshot attribution and permitted historical references after later/concurrent deletion; it must not claim serialization or permanent FK integrity. This replaces the earlier row-lock instruction above.
- gh-1360: preserve existing supported config.default fields as required by the additive projection decision. The blanket empty-config clause was inconsistent with that compatibility requirement. No API field removal, arbitrary config dump or new default application feature is authorized. Require text-with-default and other supported default compatibility tests.

- gh-1459: 71a2254f0df58f303b82fc487adac3b0862a1d00e3b5499930693d37e42ea5d6 -> e1aeba010e772ce13d583edc2a71077e7e06e20adefbb30ab65c243dfe509c69
- gh-1360: 7ee1d9c24f5550c7c0df83d19aa76c57b48debe4a9cfc50a23ba3ef75b507624 -> 269ccb3b073705421cffb7487a38bf6bebe33185c752bb85514350814a7d5b93

## Empty patches, strict REST bodies and the real drift action

- gh-1528: the schema itself must reject empty patches; the downstream guard stays defense in depth. Preserve the public validation error contract and generated operation schema compatibility.
- gh-1528: preserve external database patch keys until strict validation, with path-derived database identity kept outside the patch. Known-plus-unknown requests must fail before writes or invalidation. This is already within the named Task/Touches; no spec weakening is authorized.
- gh-1427: wire activeProcessIds into the actual core.driftCheck composition and test that action with calendar and an unknown owner. The existing separate helper test is insufficient. API composition/test paths are explicitly added to scope. Keep existing dependency-cruiser exemptions; the broad AC now names non-exempt modules.
- Missing explicit tenant predicates in drift-property scans are confirmed defects to fix across sibling scans, not reasons to relax isolation or use only superuser tests.

Source gh-1427: b0cd0f1d573b358eb40b0e0608474f5e04f98eb751a4b5eee0e902e3b566addb -> 08b569b61e76ccdcd95d40722cea00cb18e064a1d475a839eae28c3a605b9a97. Aggregate: a76307e91bc1366fe72bfaf1f1277bf4943053f9e9d9f9717ae5010a77d9edb4.

## Canonical mail database keys for actual collection visibility

The strengthened HTTP test found that seeded Emails, Mailboxes and Folders have NULL keys, so key-based manifest metadata does not apply. Authorize fresh canonical keys plus a per-tenant populated-upgrade repair of only these three system rows. Preserve ids, names, items, relations and ownership. No resolver heuristic or weaker assertion is accepted. NULL keys become their existing module constants; canonical rows are unchanged; missing rows are skipped. Unexpected non-null keys or collisions fail atomically without overwriting another row. Use existing runtime-role tenant cutover composition, explicit tenant/system identity, transactional row guards and real multi-tenant tests.

A new proposed 2026-10-31-mail-database-key-cutover ADR must explain the narrowly bounded three-row SQL exception to the existing application-code post-migration decision; no historical accepted ADR body is edited. Acceptance still requires actual list/schema visibility and fresh/populated/rerun/isolation/collision evidence. Non-normative repeated context was shortened to keep the aggregate below the existing 60000-character limit; previous Tasks, decisions and AC remain.

Source gh-1407: 9bb36fb24ac5d80aaf6b96604fd63d1872778dae0fe0ce253aab887e248d0baa -> a7142a837f5d3679fa52eb537cec08086c52ac0a51956939667d65f1f67c92a2. Aggregate: 1a43655b09fc2d2afeab1b9913977e844a08dbf07676be1d70df62135e28a865.

## Producer regression fixtures after project attribution enforcement

The diagnostic run exposed two guidance-drift tests passing fabricated project UUIDs through the real producer into raiseProblem. These are invalid positive fixtures under the approved guard. Authorize replacing only those project fixtures with real same-tenant Projects items created through production writes in backend/packages/data/src/__tests__/sempProblemsProducers.test.ts; preserve dedupe and stored-attribution assertions and verify rollback reaches its intended sentinel after a successful raise. No producer behavior change or validation bypass is authorized; producer implementation remains out of scope. The mixed-source run remains diagnostic, not acceptance evidence.

Source gh-1459: e1aeba010e772ce13d583edc2a71077e7e06e20adefbb30ab65c243dfe509c69 -> 57b9ed88d2e85a5a529e7bdf3e0a56a172f83d4472d0b9bcb8f6e0e5e1a93229. Aggregate: e6f6a3fb22a49bcf517866c4e6b5b9117590c09d58b9ece130b9489036531089.

## Final re-review: error compatibility and sibling tenant scans

Candidate 39ecb78e remains unaccepted despite the integration run failing only the known macOS environment assertion. Preserve the existing empty_patch reason at the actual REST and MCP boundaries while rejecting empty patches in the schema and advertising minProperties. A compatible additive patch field is allowed; unrelated error mapping stays unchanged. Scope the required adapters/gateway and regression tests explicitly.

The sibling isolation correction includes both moduleRegistryDriftCheck scans, properties and heartbeats. Both require explicit current-tenant predicates, fail-closed no-scope behavior and runtime-role/scoped-owner two-tenant evidence. Its global description refers to modules within one tenant. No cross-tenant collector or privilege expansion is authorized. Fix the after-commit test callback leak by retaining production transaction wrappers and prove forced initial-create/escalation overlap. Mail cutover tests must demonstrate late-failure rollback and actual overlap/collision, not only preflight refusal. These test corrections preserve the already approved contracts.

Only duplicate explanatory annotations in aggregate Touches were removed to respect the body limit; source snapshots and file paths remain.

Source gh-1427: 08b569b61e76ccdcd95d40722cea00cb18e064a1d475a839eae28c3a605b9a97 -> 7d2649534df5344ec93d666f32e2ba0d19c49cb880cfc7dba2c9a26f8df36eea.
Source gh-1528: 900c2cb6d8566bb4409a511d12fe2afab777dfe77105be59cea8f75d2e93f66b -> 77de1557812a3be8abcb837fd5f95e72c3da1153d636397a01918782f4889afe.
Aggregate: 4287361526ab7afa169509047adcf75e685c27a7dd63df74c44c9dab2b74b01b.
