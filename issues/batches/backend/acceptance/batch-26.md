# Batch 26 local integration receipt

Owner-delegated root accepted candidate `51b89461fe5135d0634ba1430671a3a9cc18ca6e`, tree `31f57e32ca26dd6ae9a1afc67b200898d3439b75`, for local integration only under the candidate-local L1–L5 below. Merge `988bd27c84db153ee33a0d087e78e67f26917a5a` has ordered parents `91becbb0d50fd8073aca338ad2f737551865d99e` and the candidate and exactly the candidate tree. This is not production approval or an overall verify PASS. Individual resolutions use the candidate commit.

Parent decision `parent-local-acceptance-51b.json` SHA-256 `a73661460ff2907beb2148207fa458180a7b69f26d642fbfbaac8b82a68d9e5e`; decision ledger `decision-ledger-51b.json` SHA-256 `7d85a8b7b30dbf847e0081dc953f13c23f862809b3af9f3c4516256af8eaef12`; acceptance packet `acceptance-packet-51b.md` SHA-256 `721d1205ffbcb100651b23979f6fe72fd6340e5ee9b4666650fbd1376cd92b55`.

## Actual outcomes and review

The one full verify on `a693244a` remains **FAIL**: six failed and 6,812 passed tests across five failed and 409 passed files. Its completed lint, format, build, unit and pre-integration checks are attributed to that SHA. The grouped run at `618adbf3` remains **FAIL** (1 failed, 71 passed); two other complete files passed with source bytes unchanged at `51b`. Full verify and full integration at `51b` are **NOT RUN**. The separate complete CLI file at `51b` passed 3/3 and its separate standalone E2E passed 47/47 in six files. These results do not turn either failed run into a pass. Current read-only artifact inspection confirmed 134 direct SQL source/dist filename and hash pairs including 0134, seed cs/en parity, resolver and compiled CLI input identity; it is not a clean/repeated-copy or deployed CLI proof.

R1 was complete NOT CLEAR at `64c709fd`; same-reviewer focused R2 was CLEAR for the approved repair delta at `a693244a`. Root directly closed the final four-source-path repair at `51b`; that is not a third review or independent final-SHA clearance. The original MCP inherited-name assertion included the extra `__CF_USER_TEXT_ENCODING`. The two original `a693` CLI DROP absences remain unestablished despite the later current-fixture absence checks.

## Candidate-local conditions

- **L1**: Local integration may use actual a693 completed verify phases plus candidate-specific scoped repairs and51b standaloneCLI/E2E. Originala693 verify FAIL6/6818 and618 group FAIL1/72 remain FAIL. Fullverify/fullintegration51b NOTRUN; executable/input-byte carry is provenance, never re-execution or overallPASS.
- **L2**: Exact observed MCP inherited-name failure with sole extra __CF_USER_TEXT_ENCODING remains recorded; no environment workaround, assertion change or automatic future exception. Originala693 two CLI DROP absences remain NOT ESTABLISHED; current51b real identities/currentabsences do not cure historical cleanup failures.
- **L3**: Accept only local proof limits indexed in decision ledger: six specific remaining observations and12 exact unresolved attribution rowIds retained as PARTIAL/NOTRUN, never universalPASS. Replay compares selected affected rows rather than every tenant row; search/timeline since serialization static vs actualGET/view; actual distinct-owner transfer infeasible under schema and NOTRUN; receipt-specific foreignUPDATE/DELETE and naturally abortedSQLFETCH not separately observed. Existing non-bypass runtime/structuralRLS/authenticated foreign-route/rollback controls are distinct; no actual tenant/privacy defect is waived. Parent finite inspection saw actual proposal-confirmation assertions and codec assertions for linked fragments, but does not claim every compound clause universally proven.
- **L4**: R1 NOTCLEAR64c709 and focused same-reviewer R2 CLEARa693 retain their original scope; root direct finite four-source-path repair closure51b is not thirdreview or finalSHA independentCLEAR. Synthetic historical fixtures not oldbinary; fakegateway not live semantic/language/provider proof; injected40001 not natural serialization; configured reviewer model/effort not independently attested. Old route-matrix/guidance-seeding missing prelaunch snapshot provenance remains limited; Events.time preexisting orphan remains.
- **L5**: Observed PID/start absence only; no universal unseen/reparented descendant or individualDROP from cluster shutdown. Owned TMP retained as inventoried evidence/cache, not activeprocessproof. Read-only51b SQL134/seedcs/en/compiledCLI parity belongs to51b; no new clean/repeatedcopy/deployCLI claim. No push/deploy/production/provider/account/web/mobile/device authorization; gh1086 unchanged OPEN/BLOCKED.

## Six aggregate gates at disposition

- **Gate 001 — PARTIAL**: - Every criterion under every embedded source Acceptance criteria section passes with recorded evidence; none may be sampled, silently omitted or treated as implemented by a stub. Source criteria retain explicit partial and unknown-attribution rows; not all are established.
- **Gate 002 — PARTIAL**: - Required backend tests and functional scenarios exercise production paths, including relevant failures, tenant isolation, concurrency, idempotency and populated-tenant migrations. Multiple real runtime scenarios ran; known specific and attribution gaps remain.
- **Gate 003 — PARTIAL**: - Independent review has no unresolved medium-or-higher findings. Confirmed findings are fixed and affected evidence is rerun against the final candidate SHA. R1 complete NOT CLEAR at 64c709fd; same-context focused R2 CLEAR at a693 for authorized repair delta; root direct 51b closure is not a third independent review.
- **Gate 004 — FAIL**: - The full backend `pnpm run verify` passes. No web or mobile verification is required. A missing external service or required live-provider check is BLOCKED/NOT RUN, never PASS. FAIL: the one complete full verify on a693 failed 6/6818. Full verify on final candidate 51b NOT RUN; separate CLI/E2E passes do not cure that failed run.
- **Gate 005 — NOT RUN**: - Only after this entire gate passes may this batch and its approved source records be completed with individual handovers pointing to the verified implementation. All source approvals must still match their specifications. Completion/handovers require gate and parent disposition; no completion performed.
- **Gate 006 — NOT RUN**: - The next sequential batch starts only after this batch's gate passes; a failure holds advancement. Successor dispatch requires gate and parent disposition; none dispatched.

## Specific missing observations

- **full-verify-51b**: Full unchanged backend verify of 51b. Not run; a693 failed including MCP env extra, two CLI DROP checks, catalog/search and adapter fixture.
- **all-row-replay**: All tenant rows unchanged on Tasks/sourceEvents/Journal replay. Fixtures check selected properties/versions, relations and item/edge projections, not every row.
- **read-surfaces**: since/sinceTime serialized via search and timeline entrypoints. Actual authenticated GET and view-query are tested; search/timeline composition is static only.
- **distinct-owner**: Actual same-tenant distinct-user transfer away and back. NOT RUN: one-user-per-tenant uniqueness and tenant-consistent owner FK make fixture infeasible.
- **receipt-foreign-writes**: Foreign runtime-role UPDATE and DELETE of receipt specifically. Separate direct negative operations not exercised; receipt foreign read, structural RLS and foreign route are distinct.
- **fetch-abort**: A naturally aborted PostgreSQL FETCH within cursor snapshot. Not independently exercised; application-side overflow and rollback/cursor settlement were exercised.

## Twelve unresolved assertion-attribution fragments

These are unclosed mappings, not demonstrated behavioral defects:

- `gh-1544:task:013:sub:01`
- `gh-1544:task:013:sub:02`
- `gh-1548:task:002:sub:01`
- `gh-1548:task:002:sub:02`
- `gh-1548:task:003`
- `gh-1548:task:003:sub:01`
- `gh-1548:task:004`
- `gh-1548:task:005`
- `gh-1548:task:005:sub:01`
- `gh-1548:task:006`
- `gh-1548:task:007`
- `gh-1629:task:005`

## Static-only or unattributed source fragments

- `gh-1540:task:009:sub:02`
- `gh-1544:task:013`
- `gh-1544:task:014`
- `gh-1544:task:014:sub:01`
- `gh-1602:task:005`
- `gh-1602:task:007`
- `gh-1548:task:002`
- `gh-1629:task:003`
- `gh-1629:task:007`
- `gh-1540:task:017:sub:02`

## Additional evidence limits

- Historical migration fixture is synthetic, not old-release binary.
- Behavior gateway is fake; no live-model semantic or language proof.
- Injected 40001 is not naturally observed concurrency failure.
- Original two scratch database DROP absences remain unestablished even though current CLI absences passed.
- Configured Terra 6.1 xhigh reviewer model/effort is not independently runtime-attested.
- Sampling cannot prove all unseen descendants absent; cluster shutdown does not prove individual DROP.
- Prior routeMatrix and guidance seeding tests had incomplete prelaunch byte snapshots as recorded.

`Events.time` remains the separately reported preexisting owner-process orphan. No exception transfers to a later candidate. No tenant/privacy defect is waived; no push, deployment, production, live provider/account, web, mobile or device operation is authorized. `gh-1086` remains byte-identical OPEN/BLOCKED for release.
