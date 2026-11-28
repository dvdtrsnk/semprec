# Native workspace runtime package resolution

Status: unresolved operational prerequisite. Owner: backend program controller.
Revisit explicitly at the batch-19 parent gate and before any operational or
release-readiness claim; a local feature acceptance does not close this item.

During batch17 development, the actual compiled migration entry
`node packages/data/dist/db/runMigrationsCli.js` failed before application
logic with ERR_MODULE_NOT_FOUND for shared/src/projectAgentGuidance.js,
including after a successful full backend build. Workspace package entries
select source while builds emit JavaScript to dist. The deployment script
invokes that compiled entry in a staged release without the test resolver.
No remote release was run; other entrypoints were not proved affected.

Original diagnostic logs are retained in worker thr_ufmvhnbx7s storage:
batch17-cli-module-load-dev.log, batch17-cli-module-load-after-build.log and
batch17-cli-preflight-build.log. The batch17 controller evidence directory
records their whole-file checksums and observed source/entrypoint context.
The prior isolated-transcription-test ADR already recorded the same general
source-export limitation; it did not claim a production packaging repair.

Gh-1570's separately approved compiled-CLI fixture uses a closed test-only
built-export resolver to prove enqueue composition and key semantics. Its
PASS is not the native command's PASS. The plain native failure remains FAIL;
runtime packaging and deployment executability remain unresolved.

A future packaging repair needs exact package/export/build/deploy scope,
dependency and consumer analysis, a recorded runtime-resolution decision and
actual native built-entry evidence. Do not patch all manifests ad hoc, change
shared host resolution, silently add the test loader to deployment or infer
release readiness from Vitest. This follow-up itself authorizes no such edit,
deployment, environment change or additional automatic review round.

## Batch 19 local native evidence

On the batch 19 implementation candidate, after a successful recursive backend build,
plain Node reached the migration entry's `DATABASE_URL is not set` application error
without a loader. The owned PostgreSQL integration scenario ran the same compiled
entry twice, asserted the single `mail-thread-backfill` job with maxAttempts 3, and
confirmed absence of its individually created database in both the normal and lost
CREATE-acknowledgement scenarios. The local test and build logs are retained in the
implementation worker's thread storage; they are not a production deployment or
proof of other compiled service entries. The earlier resolver-only result and native
failure above remain historical records. Batch acceptance remains pending.

## 2026-11-15 native evidence for the compiled service entries

On the local implementation candidate of source sp-994caf89-dfb8-465d-983f-5698cdc851af, after a
successful recursive backend build (Node 26.12.1 on the delivery host), eight further workspace roots
(`@alldots/data`, `realtime`, `application`, `notifications`, `ai-gateway-client`, `ai-gateway`,
`agent-runtime` and `credentials`) select `dist/index.js` for plain Node under
`docs/adr/2026-11-15-workspace-root-exports-for-the-service-entrypoints.md`. The failure text above
(`ERR_MODULE_NOT_FOUND` of the plain compiled entries) stays as the historical record of the state before this change.

Proved natively, as plain `node <entry>` from `backend/` with an environment of `PATH` and `HOME` only: all eleven
compiled entries that `deploy.sh`, the units, the timer scripts and the restore runbook start
(`packages/data/dist/db/runMigrationsCli.js`, `runSeedCli.js`, `verifyTenancyCli.js`,
`tenancy/validateRestoreLedgerCli.js`, `tenancy/restoreTenantKeysCli.js`, `tenancy/replayTenantDeletionsCli.js`,
`observability/restoreTestResultCli.js` and the `dist/serve.js` of `alldots-api`, `alldots-agents`,
`alldots-ai-gateway` and `alldots-transcribe`). Each ends in its own configuration refusal and none in a
module-resolution error; `backend/scripts/check-native-entrypoints.mjs` exits 0 naming all eleven, and
`deploy.sh` now runs it after the build and before the migration. That proves module loading and the refusal, not a
start.

Started and stopped natively against an owned scratch database as the runtime role (placeholder keys, no network
call): `alldots-ai-gateway` logged `alldots-ai-gateway listening`, `alldots-agents` and `alldots-transcribe` logged
`... queue runtime started`, and each exited 0 within 20 seconds of SIGTERM and logged its shutdown completion.
`packages/e2e/src/__tests__/nativeEntrypoints.e2e.test.ts` runs these cases.

Still open: `alldots-api` was not started, and its start under the production default of strict tenant scope is a
separate, known defect (`createApiQueueRuntime` calls `runHeartbeatFireQueueSplitMigration` outside any tenant
scope). Nothing here is a production deployment, a deployed host or a release-readiness claim, and the production
Security gate stays BLOCKED.

## 2026-11-15 the compiled API start under strict tenant scope (sp-b08abab8-34a6-4359-acb6-5d0e249ef45e)

On the local implementation candidate of source sp-b08abab8-34a6-4359-acb6-5d0e249ef45e (Node 26.12.1 on the
delivery host), the compiled `services/alldots-api/dist/serve.js` was started from its compiled entry with
`ALLDOTS_TENANT_SCOPE` unset (the default, strict) against an owned scratch database as the `alldots_data` runtime
role, with placeholder configuration and no network call. It logged `alldots-api listening`, answered
`GET /healthz` with 200 `{"status":"ok"}` and exited 0 within 20 seconds of SIGTERM with
`alldots-api shutdown complete`; the scratch database was dropped and absent. The compiled `alldots-agents`,
`alldots-ai-gateway` and `alldots-transcribe` were started under the same condition (the environment passed to
each child has no `ALLDOTS_TENANT_SCOPE` key although the test process has one) and reached their log lines and
exited 0. The cause of the earlier exit with `TenantScopeMissingError` was the `heartbeatFire` queue-split
migration that `createApiQueueRuntime` called outside any scope; the call is removed, and that one-time step stays
in the deploy CLI (`db/runMigrationsCli.ts`), which moved a queued legacy job under `heartbeatFireCore` with the
seeded tenant in its envelope on a second run in the owned-database deploy-order case. The statement above that the
API start under strict scope was open stays as history. Nothing here is a production deployment or a claim about
a deployed host, and production readiness stays BLOCKED.
