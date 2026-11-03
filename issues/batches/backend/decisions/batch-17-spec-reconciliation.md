# Batch 17 specification reconciliation

Authority: owner-delegated controller supervision under the sequential backend program. This is dispatch scope, not implementation acceptance. Existing implementations and original handovers must be reconciled against every current clause.

## 1. Native validation projections (gh-1432, gh-1436)

Preserve the shared hook's ValidationError status400/code validation_failed and failing details.field. REST projects HTTP400. The existing agent tool projects its code-prefixed error text, without an invented structured field. The authenticated well-formed MCP tools/call maps ValidationError to HTTP200 JSON-RPC -32602 and the existing error data details, following the accepted2026-09-18 MCP JSON-RPC transport ADR. The sources' numerical400 wording describes the domain rejection; their refreshed AC explicitly distinguish native envelopes. No auth, approval, validation, transaction or error-mapping change is authorized. Prove typed field/error at the shared data boundary and exact actual native responses plus no write at their named transports.

## 2. Exact existing transport harnesses

Gh-1432 and gh-1436 explicitly require real REST/agent/MCP behavior, but their original Touches listed only data harnesses. Authorize the exact existing itemsHandler.test.ts, genericOperationAgentTools.test.ts and mcpRunCredentialTenancy.test.ts paths now named in each source, solely for those clauses and positive/no-effect controls. Gh-1490 likewise requires each actual read/write/conflict projection path; the same exact three existing harnesses are authorized for those cases, with internal raw-row and other-module controls retained. Do not replace actual transports with helper-only tests or create a parallel router.

Gh-1439 may use the existing API tenantIsolationRoutes.test.ts solely for authenticated GET /api/inbox-types cs/en additive fields, unknown-target fallback and archived exclusion. Gh-1494 may use the existing REST/agent harnesses solely for flag-patch transactional mailbox enqueue, along with its named mail data tests. No new production route or transport feature follows from these test-only paths. Keep tenant-runtime-role positives/refusals and finite owned test resources where relevant.

## 3. Existing enqueue extraction (gh-1494)

Task 2 already permits moving the mailbox enqueue helper and fixed job-key function to a small shared module to avoid an import cycle. The recovered implementation uses mail/mailSyncEnqueue.ts. Name that exact existing module in Touches; preserve helper/barrel compatibility and the existing dedup/transaction contract. No worker execution, provider write-back, generic queue redesign or additional mail behavior is authorized.

## 4. Scope and evidence boundaries

The aggregate's top-level Touches is the exact union of the full current member Touches embedded within the same self-contained issue, avoiding a stale duplicate list. All member Context/Task/Scope/AC remain exact. Pure journal unit tests must remain in the no-Postgres tier; backend localization catalogs are in scope, app/client catalogs are not. Historical fixtures need a genuinely relevant earlier schema or explicit classification; do not invent stored production corruption. Backfill must use actual managed, chunked tenant transactions and precise current coordination contracts, not silently expand to schema changes or new global locks.

Gmail/Graph sending uses fake provider HTTP only; prove MIME/thread-id/Message-ID, dedup and cleanup at the actual local boundaries without claiming live provider state. Keep credentials tenant-scoped and refresh commit ordering intact. Accepted SMTP/IMAP and OAuth sync privacy decisions have exact scopes: do not silently extend them to a distinct send boundary or allow raw secret-bearing errors. Report a concrete privacy/ownership/HTTP-size/upload-session or lifecycle conflict for a bounded controller decision before selecting a new protocol. Likewise, locate an actual enqueue-at-deploy root for gh-1570 before claiming it is wired; a dead exported helper is not deploy evidence. Existing live-provider, remote deployment and app/device checks are not authorized and must not become a simulated PASS.

## 5. Finite review and final gates

Maximum two automatic independent rounds: one complete grouped Task/AC/production/security/lifecycle audit, then one SAME-reviewer focused bundled repair delta with independent unchanged-byte complete-ledger reconciliation. Resume an incomplete first audit in the same context; do not restart it. After round2 the controller directly disposes remaining findings. Cheap lows, speculation and optional combinations are follow-ups; concrete security/data/behavior and explicit-clause failures require correction or recorded adjudication. Frozen test failure does not reset the review budget. No automatic third/new reviewer/CLEAR loop.

Freeze the final clean SHA for serial complete named unit/integration/shared/actual COMPLETE E2E plus backend build/lint/format, actual argv/PID/exit/log hashes and immediate ROOT non-web/mobile tracked byte manifests. Write explicit STOP, then invoke unmodified backend pnpm run verify once as a separate serial stage. Preserve FAIL and NOT RUN; no previous candidate/batch exception transfers. No local merge or guarded completion before exact candidate-specific controller acceptance. No push, develop merge, deployment, live provider, client, device or successor dispatch.
