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
