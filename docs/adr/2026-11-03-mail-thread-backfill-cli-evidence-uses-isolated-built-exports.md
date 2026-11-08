---
status: accepted
date: 2026-11-03
area: [backend]
supersedes: []
superseded-by: null
---

# Test mail-thread backfill CLI composition with isolated built exports

## Context

Gh-1570 queues the mail-thread backfill from the existing migration CLI. The
local command `node packages/data/dist/db/runMigrationsCli.js` fails during
module resolution after a successful build: workspace package entries select
TypeScript source whose relative JavaScript imports are absent there. The
failure occurs before application enqueue logic. The staged deployment script
names that same compiled entry; no remote deployment has been performed.

[[2026-11-01-transcription-http-evidence-uses-an-isolated-producer]] documents
the same source-export limitation and permits a closed built-export resolver
for two other tests only. This standalone decision applies that bounded test
composition to the migration CLI. It neither expands the older ADR's scope
silently nor repairs production package exports.

## Decision

The data integration test owns an isolated temporary database and a native
Node child that executes the real compiled migration CLI. Before application
imports, a test-only bootstrap registers its closed resolver. It maps only an
explicit allowlist of currently declared public workspace exports required by
that CLI graph to their existing built JavaScript. Unknown workspace imports,
missing builds and invalid fixture input fail clearly. Third-party resolution
is delegated unchanged. No invented deep exports, source fallback, import
rewriting of production code, mocked CLI enqueue or alternate migration root.

If the existing no-emit block-model package is in this graph, the test may emit
that package alone through its existing compiler/project with explicit
noEmit/declaration/incremental command-line overrides into a unique owned
temporary directory beneath that package. Only its declared public entry maps
to that output. Validate the real path and ownership; remove it on every
outcome. No tracked compiler/config/package/lockfile changes, new dependency,
global loader or shared service changes.

Build the current backend artifacts before this test. Record the actual
build/run commands, candidate source identity and compiled entry provenance.
The test runs actual migration and queue code on its owned database, verifies
the mail-thread job's fixed key and maxAttempts, repeats the CLI and verifies
key deduplication. The resolver does not intercept or replace these operations.
Bound child runtime and output, capture its owned identity, join termination
and database cleanup before restoring test state, and preserve primary and
cleanup failures. A failed child never becomes a successful enqueue assertion.
Credentials stay in the isolated child environment, not arguments or reports.

This fixture command includes its explicit test bootstrap; it is not described
as the unmodified deployment command. Preserve the plain native command's
observed failure and label production package resolution and deployment
executability unresolved. Do not install the resolver in deployment, use it to
alter full verify, suppress the failed diagnostic or claim live deployment.

The issue delivers and tests the source-level deploy composition and enqueue
semantics under this declared local runtime. Production workspace packaging is
a distinct operational prerequisite tracked by the controller. It must be
revisited before an operational/release-readiness claim; this test does not
clear it. No production package/deployment repair is authorized by gh-1570.

## Alternatives considered

- Repair all workspace runtime package entries in the mail backfill issue:
  changes unrelated package consumers and development resolution contracts,
  needing a separately scoped design and verification.
- Treat a helper-only enqueue or source grep as CLI execution: misses the real
  migration-root sequence and failure propagation.
- Import the source CLI under a TypeScript test runner and call it deployment:
  obscures the observed native compiled-entry failure.
- Permit arbitrary mappings, source fallback or a global runtime loader:
  hides missing builds and changes runtime behavior beyond this finite test.

## Consequences

The fixture proves the actual compiled root's enqueue logic with the explicit
resolution seam and owned database. It does not prove unassisted native Node
package resolution, a production release, remote migrations or deployed
worker execution. Final evidence and acceptance retain both the fixture
result and the separate failed native preflight. The older accepted ADRs,
production exports and deployment commands remain unchanged.
