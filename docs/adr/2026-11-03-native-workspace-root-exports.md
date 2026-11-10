---
status: accepted
date: 2026-11-03
area: [backend]
supersedes: []
superseded-by: null
---

# Resolve the migration entry through built workspace roots

## Context

Batch 19 security review retains the observed failure of the plain compiled
migration entry after a successful build. The migration reaches source package
entries whose relative JavaScript imports are absent. A test resolver proved
selected composition but did not prove the native command used by deployment.
Corrective issue `sp-62b97861-bb73-46ec-83d7-2dcfd881b16a` owns the repair under
[[2026-10-31-owner-delegated-backend-program-supervision]].

A finite runtime-import source graph identifies four workspace roots:
`@semprec/shared`, `@semprec/queue`, `@semprec/module-registry`, and
`@semprec/block-model`. This graph excludes external dependency internals and
does not prove arbitrary dynamic modules or other service entries. Replacing
every workspace manifest, copying source JavaScript, or installing a deployment
loader would expand the repair beyond that evidence.

## Decision

Change only these four root package contracts: `main` selects `dist/index.js`,
`types` retains `src/index.ts`, and the root export has ordered conditions
`types: ./src/index.ts`, `browser: ./src/index.ts`,
`default: ./dist/index.js`. Plain Node selects the built default. Browser-aware
source consumers retain their existing source entry; no browser build is
claimed. Preserve queue's existing `./testSupport` entry and all other existing
subpaths. Block-model's build must emit its JavaScript and declarations into
`dist`; a successful no-emit check is insufficient.

The three backend Vitest tier configurations explicitly alias these four exact
root names to their source entries. Do not alias every `@semprec/*` import or
redirect arbitrary subpaths. Preserve the existing test mock spelling
`@semprec/shared/src/logger.js` through one exact test alias to its source file;
do not add a production source subpath solely for that mock. Prove actual source
module identity in relevant tier/global-setup contexts without overwriting
shared build artifacts or merely inspecting an alias declaration. Unit evidence
must not import the PostgreSQL graph.

The release layout remains the staged repository tree: backend and
shared/block-model are adjacent, pnpm workspace links are installed there, and
the recursive build completes before native execution. No deployed condition
override, test resolver, tsx loader, host setting, or deploy-script workaround is
introduced. Remove the old fixture resolver only after the genuine native entry
has current build provenance and owned real-database evidence. A source graph,
module load, and application configuration refusal are distinct from a
successful migration/backfill execution; record each actual result.

## Consequences

This is a narrow runtime packaging contract, not proof that every compiled
service now starts. Types and browser-source resolution remain separate from
the native built artifact. Missing build output fails loudly. Any newly reached
workspace root requires concrete analysis and parent scope adjudication rather
than a wildcard manifest change. Native tests must capture built-byte provenance
and settle their own children and databases; historical cleanup failures and
resolver-only results remain historical evidence.
