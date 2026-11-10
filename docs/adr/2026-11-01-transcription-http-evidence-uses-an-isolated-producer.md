---
status: accepted
date: 2026-11-01
area: [backend]
supersedes: []
superseded-by: null
---

# Compose transcription HTTP evidence through an isolated test producer

## Context

Gh-1386 requires reading a real transcription failure notification over HTTP;
gh-1582 requires a restored stopped transcript to run through the rerun route.
Data-row assertions and direct handler calls do not establish those boundaries.
Importing transcribe code from API tests would violate `no-service-to-service`
in `backend/dependency-cruiser.rules.json` and the API compilation root.

The workspace's public package exports point at TypeScript source, so native
Node cannot directly execute a compiled fixture that follows those exports'
relative JavaScript imports. Production export/deployment repair is outside
these Tasks. This decision is a bounded test composition under
[[2026-10-31-owner-delegated-backend-program-supervision]].

## Decision

API tests own their normal HTTP server and the existing ephemeral database.
They spawn an owned transcribe-side fixture with `process.execPath`, using its
JavaScript compiled by the existing transcribe build. The fixture imports its
own production task and public shared/data/queue seams only. It produces actual
notification/automation/checkpoint state or consumes the actual rerun job in
that same database, with injected owned fake gateway and storage. No service
imports another service, and no notification row is manufactured as a substitute.

Before workspace value imports, the fixture registers its test-only resolver
hook, then dynamically imports the task. The hook maps only an explicit
allowlist of declared public workspace exports, including data's testSupport,
to their existing built JavaScript. It does not rewrite service entrypoints,
invent deep exports, fall back to source or change third-party resolution.
The existing pure block-model package has a no-emit build. The private API test
helper may emit that package alone using its existing compiler/project with
explicit noEmit/declaration/incremental CLI overrides into a unique owned
temporary directory beneath that package. Only its declared public entry maps
to that temporary JavaScript; ordinary dependency resolution is preserved.
Remove the output on every outcome and retain build/exit evidence. No tracked
shared source/config, package manifest, lockfile, production export, global
loader/compiler or boundary rule changes. Other missing builds and unknown
fixture input fail clearly rather than fall back to source.

The child inherits the isolated database environment; credentials do not enter
arguments or reports. Test control input and result frames are bounded and
validated. The owner bounds runtime/output, awaits exit and settles/closes its
own pools, servers and processes, preserving the primary failure. Runtime tests
need no extra PostgreSQL instance, TypeScript loader, live service or provider.

The HTTP tests assert authenticated unread/visit output for a task-produced
failure, its transcript link and omission of a distinct stored diagnostic.
The restore/rerun scenario proves deleted-stop state, the real authenticated
route and enqueue, consumption by the registered production transcription task,
and completion. Only committed checkpoints are reusable; uncheckpointed
in-flight work may repeat and is not described as already completed.

## Alternatives rejected

- Import transcribe source from API tests. That crosses the service boundary.
- Test the HTTP reader with a fabricated failure row. That misses producer
  composition and can pass while the actual notification is wrong.
- Add production exports or a general test runtime. These Tasks need two
  bounded scenarios using existing builds, not a new package/deployment system.

## Consequences

The existing API integration suites own the HTTP assertions; the transcribe
fixture remains test-only. Full verification builds both before integration,
and targeted runs must do the same. Final evidence binds source, build/run
commands and captured exits to the reviewed candidate. This does not establish
deployed package resolution, real provider delivery or device behavior.
