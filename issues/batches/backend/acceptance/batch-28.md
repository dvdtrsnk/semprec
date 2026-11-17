# Batch 28 local integration receipt

Candidate `ea91beb62d897a1bed4797f62f55c9a27678a549` (tree `255af76b1a0b6b9a30e10af8b380ad7b1d088098`) was accepted for local integration only under `docs/adr/2026-11-03-local-development-continues-with-open-production-gates.md`; merge `146bea84a4ef2996c5c64de4915cdabd6c44f5fa` has ordered parents `fae5a37db5214a90c9fb720f3a51b00603f27a7e` and the candidate and exactly the candidate tree. Source resolutions point to the candidate. No production or release approval follows.

Parent acceptance `parent-local-acceptance-ea.json` SHA-256 `1b9cd8b15b453ecad764847278abe0ef952b8e7c95302bb5e2ca930648fff8b6`; keyed ledger `ledger-final-decision-ea.json` SHA-256 `ce168684c3f60283de7eaf0baab0d225fdee096de5726b25a474075b173d96b8`; bounded condition mapping `supplemental-condition-mapping-ea.json` SHA-256 `661cf4bbc070c05285d1b84725bd40880d56d8e004cb895e2a143c537604e4c9`; reconciled decision packet `decision-packet-ea-reconciled.md` SHA-256 `db0ca7e0ba80942b98754d3ae27a61adaf914a2b83eb10aa5593dab8daed4f90`. These artifacts are in `batch-28-run/` under the parent thread storage; exact scenario, source, line, log and attribution remain in the ledger.

## Candidate-local conditions

- **L1**: Candidate-local accept separately pinned completed054 phases and scoped test repairs with exact byte/mode/blob carry. Original verify0702 FAIL and integration054 FAIL3/6952 remain; full verify/integration on ea NOT RUN. No overall PASS.
- **L2**: Accept local progression despite existing MCP extra inherited __CF_USER_TEXT_ENCODING and historical migrationCompatibility DROP timeout. Current unchanged migration file passed in28/28 smoke/compatibility on a02; original DROP absence and root cause UNKNOWN. No environment/timeout workaround or future waiver.
- **L3**: Supplemental mapping resolves72 earlier unspecified keys to scoped/static witnesses. Accept split observation of three-speaker cards and separate empty-candidates scenario; no combined three-speaker/no-candidate-third proof. created_at DEFAULT/insert remains static, not measured time. Captured sentinel privacy proof is limited to its worker logger. Other external/typed-hint/synthetic/future-scope limits remain explicit; no blanket source-criterion PASS.
- **L4**: Original fullR1 FINDINGS and same-context focusedR2 NOT CLEAR remain on original SHAs. Confirmed finite findings and later test/typing compatibility fixes closed by direct parent inspection and actual affected checks; no independent final-SHA CLEAR, third review or runtime model/effort attestation.
- **L5**: Local development only: preserve absent Hunspell morphology/live providers/historical-binary limits, committed-checkpoint retry boundary, HTTP revise deferredgh1870, typed invitation hint limitations and sampled process/unseen/reparented/individual DROP uncertainties. gh1086 remains byte-identical OPEN/BLOCKED; no production/release authorization.

## Original six gate statuses at local disposition

- **Gate 001 — PARTIAL**: - Every criterion under every embedded source Acceptance criteria section passes with recorded evidence; none may be sampled, silently omitted or treated as implemented by a stub.
- **Gate 002 — PARTIAL**: - Required backend tests and functional scenarios exercise production paths, including relevant failures, tenant isolation, concurrency, idempotency and populated-tenant migrations.
- **Gate 003 — NOT CLEAR**: - Independent review has no unresolved medium-or-higher findings. Confirmed findings are fixed and affected evidence is rerun against the final candidate SHA.
- **Gate 004 — FAIL**: - The full backend `pnpm run verify` passes. No web or mobile verification is required. A missing external service or required live-provider check is BLOCKED/NOT RUN, never PASS.
- **Gate 005 — NOT RUN**: - Only after this entire gate passes may this batch and its approved source records be completed with individual handovers pointing to the verified implementation. All source approvals must still match their specifications.
- **Gate 006 — NOT RUN**: - The next sequential batch starts only after this batch's gate passes; a failure holds advancement.

## Actual outcomes and limits

Original full verify on 0702 failed at lint; separate 054 integration failed 3/6952 (MCP inherited `__CF_USER_TEXT_ENCODING`, historical migration DROP timeout, obsolete Threads smoke expectation). The original DROP result and database absence remain unknown. The later 28/28 smoke/migration diagnostic did not explain that timeout. The a02 full E2E failed 1/48: its five passed files have byte/mode/blob carry to ea; the corrected complete file passed 1/1 on ea in a separate run. There was no single 48/48 passing run, full integration on ea, or full verify PASS. Earlier development and scoped-lint/typecheck failures remain as listed below and in immutable receipts. R1 FINDINGS and R2 NOT CLEAR remain on their reviewed SHAs; no independent final-SHA CLEAR or third review. Hunspell morphology, live providers and old binaries were not observed; historical fixtures are synthetic. HTTP revise is deferred to gh1870. Model calls before committed checkpoint have no exactly-once guarantee. Captured worker-log sentinel covers the observed logger only; typed invitation statuses are hints only. Known PID samples do not prove unseen/reparented settlement or individual DROP.

The three-speaker scenario observes one proposed and two clarification cards with the third using an already used candidate; a separate executed scenario has no candidates. No same-test three-speaker/no-candidate-third claim is made. Fresh created_at is supported by the migration default and insert as static evidence, not by an isolated timing measurement. gh-1086 remains byte-identical OPEN/BLOCKED, SHA-256 `4c047b54ee073dfe919be709856ed8f6d481aa08687824a8132323f344b04363`.

## Preserved historical command failures

- `dev-owner-regressions`: exit 1, log SHA-256 `e73f4dc989d191dc16ee4aa17d661847542afc62f24bc3a0749471d25ab1e613`.
- `dev-recording-transcript-owners`: exit 1, log SHA-256 `c396fb2ad8fbb2d96d61ac2c455f1887aa28371e75a5f81c9cbf6464c8cc6dd4`.
- `dev-small-unit-contracts`: exit 1, log SHA-256 `3cccdc0e630b99b41b5ef7ba30694fd8d3e76a0618b4cb7123f7792e41932f36`.
- `dev-write-safety-host`: exit 1, log SHA-256 `45009d62f3f6500272ca8fc55d326657202275c533d2144bd9da492ce75d81c5`.
- `lintfix1082-scoped-lint`: exit 1, log SHA-256 `d57e398db90ad122210da1c2b4277451415061ece3a223478a4df6e21395fdf2`.
- `lintfix979-api-typecheck`: exit 1, log SHA-256 `05d1b81c6737f75f4b8342cf1df13549e8898f9f631bbd20ec926c44bbdc10cc`.
- `resume054-integration`: exit 1, log SHA-256 `67e774d4c65eaf4df4de9e728f1d7022890c7058b6700710c3ed2a95bac6aa21`.
- `smokea02-e2e`: exit 1, log SHA-256 `993f12bedc53820627c80a268f65c2a80bf37f5aa4788b6ecc741011955826d2`.
- `verify0702`: exit 1, log SHA-256 `ddedf7fcff923dc8f13f57cbd645d392c43994c26320dc223f7fa5043381938a`.

Completion is local only, under the cited accepted ADR and parent candidate-specific decision. The historical all-gates-pass predicate is not claimed; no successor or production operation is authorized by this receipt.
