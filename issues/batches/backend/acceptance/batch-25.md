# Batch 25 local acceptance receipt

The owner-delegated parent accepted implementation `2781333e98c3ab34cc4b520e17421610f297dd32`, tree `220877ebe8c03be79be6b1f0b1899857888c2e3e`, for local integration only. Merge `904c254ced04e3aba418bcb279dc417752ecd7bc` has ordered parents `185a9300ad28fe014fe03ad821acce4e6448dc78` and the candidate, and the candidate-identical tree. The individual completed records and handovers use the candidate as their implementation resolution.

The retained parent decision `batch-25-run/parent-local-acceptance-278.json` has SHA-256 `ca6c8f2879b0ade182f10604207d1c16138bc5a47e1cdd8cb4f42cdb13bc378a`. The corrected clause ledger `batch-25-run/decision-ledger-278.json` has SHA-256 `d2bda4e4c77d2592c84ee8d8dd152a30be9cf551ff4d2c56b567b84555d97cdf`; the acceptance packet has SHA-256 `b04e10e2a449bdb123f03ef8c9d0e4eb3224c89b3a51627a47c952db78870d6b`. The parent continuation audit has SHA-256 `01f2f7769cb62c083ef1c3d634c60af66f02134e96ec1235532ee40d944a5fa2`.

## Actual validation and review

Original full verify fc1 FAIL1backendunit,2292passed; lint/format/buildPASS. Successor corrected complete unit21PASS; full integrationFAIL sole MCP environment-name assertion,6766PASS; standaloneE2E6files47PASS; block-model162/repo637 and all planned remaining checksPASS. No successor fullverify/fullbackendunit run. Original `fc1` full verify remains FAIL and its log SHA-256 is `70fd6efcb07fac74703443ea6533776d4e5aa4507124f80f39f9c2ab66c23c5c`. Full integration on `278` remains FAIL and its log SHA-256 is `07742ec05df538780965bbbeb971967d05d3c7e004991e4c91cbc6f0f9bf8b4e`; standalone E2E PASS log SHA-256 is `73e66388e5b9278dfb59fc61e68a85f3380403be8dcaf17b42be6d6e6c188f74`. Successor full verify and full backend unit are NOT RUN. The original flat-SQL `133`-prefix check FAIL and its separate corrected interpretation remain recorded; the seed clean/stale/repeat proof is carried from `fc1`.

One complete R1 NOT CLEAR on11486231; one focused same-reviewer R2 findings one43e03c3; finite postreview tests and catalog fixture directly inspected/closed by parent. No third review or independent CLEAR claimed.

## Candidate-local exceptions

- **L1**: Accept reused fc1 lint/format/build and other2292unit execution plus corrected complete successor unit21 and explicit unreached phases. fc1 fullverify remainsFAIL and successor fullverify/fullunitNOT_RUN; source/blob carry is provenance, not re-execution.
- **L2**: Accept local integration despite sole actual full integration MCP inherited-name assertion with extra __CF_USER_TEXT_ENCODING.6766other tests pass and standaloneE2E47pass. No environment workaround/assertion weakening, production clearance, automatic future exception or overall verifyPASS.
- **L3**: Accept listed16 local evidence limits explicitly asPARTIAL/STATIC: deploy/later activation wiring inspected plus real helper/worker controls but no actualCLI; Emails exclusion and no migration deletes inspected with separate runtime controls but no spanning row fingerprint; Journal direct populated-inbox/absent-doc count and exact-date HTTP/notifier combinations lack direct assertions while internal values, real HTTP concurrency/auth/sync and owner paths are separately covered; actual MCP and SDK each match common resolver on distinct runs, not same cross-service run. These are accepted proof limitations, not direct tests or universal correctness claims.
- **L4**: R1/R2 original findings/provenance stay immutable; parent direct closures cover final deltas. Review runtime model/effort not independently attested. Discarded multipart text/plain cannot be recovered; R1-3 examples rejected only with recorded failed-precondition diagnostics. No old release binary, live provider/account/device validation.
- **L5**: Process sampling proves only recorded observed identities; not unseen/reparented descendants or individual DROP. Seed/SQL artifact evidence belongs tofc1; original133-prefix probeFAIL and separate correction remain. One voice-owning API process only; unresolved handler work retains fail-closed same-user reservation. No distributed or production safety guarantee.

## Sixteen explicit partial evidence rows

- **gh-1589.task.5**: Production deploy enqueue wiring is static plus real handler and queue-readiness simulation; actual deploy CLI not exercised.
- **gh-1589.ac.5**: Generic backfill excludes Emails and migration contains no deletion by static inspection; no dedicated existing Emails row fingerprint spans both migration and full reindex.
- **gh-1741.task.3**: Real worker, successor, repeat identity and static deploy wiring are covered; actual deploy CLI invocation and later activation invocation are not directly run.
- **gh-1537.task.4**: Empty-day inbox response is asserted; populated computed inbox is tested separately, but its presence in the actual period response is not directly asserted.
- **gh-1537.task.8**: Empty-day test checks item count but does not directly fingerprint docs count, and exact empty-day literal is exercised via read handler rather than a fresh empty-tenant HTTP request.
- **gh-1537.ac.1**: Empty-day handler checks item count and null docId; docs row count is not independently checked and HTTP fixture uses a populated day.
- **gh-1541.task.5**: Sync open is observed and choke-point invalidation wiring is inspected; this test does not independently assert Journal item invalidation or absence of a doc notification.
- **gh-1541.task.6**: Exact calendar literals are exercised through internal ensure; HTTP concurrency uses a different valid date and HTTP sync uses one 2026-10-16 request.
- **gh-1541.ac.1**: Concurrent exact 2026-10-16 calls are internal ensure; real concurrent PUT uses 2032-08-15.
- **gh-1541.ac.2**: Exact week/repeat is exercised by internal ensure; no exact week/2026-W53 PUT assertion found.
- **gh-1541.ac.3**: Exact 2031-05-02 success is internal ensure; HTTP invalid and route-level unauthenticated controls exist, but exact future PUT is not separately asserted.
- **gh-1541.ac.4**: Exact date/week values are checked by internal ensure and period computation; exact PUT pair and returned day-to-week association are not separately asserted.
- **gh-1613.task.3**: Absent entry returns null and existing-page fingerprints stay unchanged; an independent absent-page docs-row count is not asserted.
- **gh-1613.ac.3**: Null is asserted for an absent entry and existing-page no-write fingerprints pass; no separate absent-page docs-row count is asserted.
- **gh-1580.task.4**: Real restricted MCP and actual SDK session each match shared resolver for different real runs; identical same-run end-to-end cross-service output is not established.
- **gh-1580.ac.2**: MCP and real SDK each match the shared resolver in distinct run fixtures; direct same-run cross-service response equality is not established.

## Aggregate gates

- **sp-c057efef-e07e-4a64-86c8-303526adcf3e.gate.1 — PARTIAL**: Every criterion under every embedded source Acceptance criteria section passes with recorded evidence; none may be sampled, silently omitted or treated as implemented by a stub. Local exception only; not a literal PASS.
- **sp-c057efef-e07e-4a64-86c8-303526adcf3e.gate.2 — PARTIAL**: Required backend tests and functional scenarios exercise production paths, including relevant failures, tenant isolation, concurrency, idempotency and populated-tenant migrations. Local exception only; not a literal PASS.
- **sp-c057efef-e07e-4a64-86c8-303526adcf3e.gate.3 — PARTIAL**: Independent review has no unresolved medium-or-higher findings. Confirmed findings are fixed and affected evidence is rerun against the final candidate SHA. Local exception only; not a literal PASS.
- **sp-c057efef-e07e-4a64-86c8-303526adcf3e.gate.4 — FAIL**: The full backend `pnpm run verify` passes. No web or mobile verification is required. A missing external service or required live-provider check is BLOCKED/NOT RUN, never PASS. Local exception only; not a literal PASS.
- **sp-c057efef-e07e-4a64-86c8-303526adcf3e.gate.5 — NOT_RUN**: Only after this entire gate passes may this batch and its approved source records be completed with individual handovers pointing to the verified implementation. All source approvals must still match their specifications. Local exception only; not a literal PASS.
- **sp-c057efef-e07e-4a64-86c8-303526adcf3e.gate.6 — NOT_RUN**: The next sequential batch starts only after this batch's gate passes; a failure holds advancement. Local exception only; not a literal PASS.

These exceptions apply only to the named candidate. They do not establish production clearance, a live provider or account check, old-binary provenance, unseen-process settlement or an individual historical DROP. The voice deployment is restricted to one voice-owning API process. `gh-1086` remains byte-identical OPEN/BLOCKED for release; there is no push, deployment or successor dispatch.
