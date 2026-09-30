---
status: accepted
date: 2026-09-30
area: [backend]
supersedes: []
superseded-by: null
---

# A domain's choke-point write side effect runs through a per-process hook registry

## Context

[[2026-09-24-choke-point-composed-from-domain-modules]] split the generic
choke point into per-domain modules under `backend/packages/data/src/chokePoint/`
and forbids one domain module importing another
(`no-choke-point-domain-cross-import`), but nothing stopped a choke-point
module from importing a domain folder directly, and two did:
`chokePoint/itemWrites.ts` imported `recordDesiredMailMessageFlags` from
`mail/mailMessageFlagSyncStore.ts` and `advanceTaskRecurrenceWithClient` from
`tasks/advanceTaskRecurrenceWithClient.ts`, each guarded by
`database.ownerModuleId`; `chokePoint/relationOps.ts` imported
`assertSpeakerEdgeWritable`/`isTranscriptSpeakersProperty` from
`transcription/transcriptionSpeakerEdges.ts`. Both are the right behaviour —
[[2026-09-10-side-effects-follow-the-commit]] and
[[2026-09-28-module-transactional-side-effects-inline-at-choke-point]] require
the write and its domain side effect to share one transaction — but the
generic write path knew three domains by name, and every further domain
wanting the same would add another import with nothing to catch it.

[[2026-09-28-module-transactional-side-effects-inline-at-choke-point]]
documents the inline-import shape this ADR's Decision replaces for all three
side effects it names — the Emails desired-flags write, the Tasks recurrence
advance, and the Transcript speaker-edge validation. Issue #659, which this
ADR implements, scopes `supersedes: []` and forbids editing any existing ADR
file (`git diff --stat docs/adr/` must show no other file changed), so
`2026-09-28-module-transactional-side-effects-inline-at-choke-point` stays
`accepted` even though the inline-call shape it describes no longer exists in
the code after this PR. A reader who finds both ADRs while adding a new
domain's transactional side effect should follow this one, the registry —
not the inline-import shape 2026-09-28 documents. Reconciling the two
ADRs' frontmatter (a proper supersession) is left to a follow-up issue,
per this repository's "the issue is the law" convention: it is not this
ADR's decision to make.

`ChokePointDeps`/`createChokePoint()` could not carry these as injected
dependencies: about sixty call sites across every domain (mail sync, inbox,
docs, library, tasks, transcription, …) call `createItemWithClient` /
`updateItemWithClient` / `createRelationWithClient` directly with a `client`
they already hold, not through a `ChokePoint` instance, so there is no single
construction point to thread a dependency through. A per-process registry —
the pattern [[2026-09-12-per-process-agent-run-watch-registry]] and
[[2026-09-12-per-process-doc-sync-subscription-registry]] already use for the
same shape of problem — does not need one.

## Decision

`chokePoint/hooks.ts` is a shared module (owned by no domain, per the choke-
point ADR) exporting two module-level registries: `registerItemUpdateHook` /
`runItemUpdateHooks` for `updateItemWithClient`'s write, and
`registerRelationEdgeWriteHook` / `runRelationEdgeWriteHooks` for
`createRelationWithClient`/`updateRelationWithClient`'s write. Each registry is
a `Set`, so registering the same function twice is a no-op. `run*` awaits
every registered hook sequentially, in registration order, inside the caller's
already-open transaction; the first rejection propagates and the transaction
rolls back exactly as a direct call's rejection did.

A domain exports its own hook next to the logic it wraps —
`mailMessageFlagsItemUpdateHook` in `mail/mailMessageFlagSyncStore.ts`,
`taskRecurrenceItemUpdateHook` in `tasks/taskRecurrenceItemUpdateHook.ts`,
`transcriptSpeakerEdgeWriteHook` in `transcription/transcriptionSpeakerEdges.ts`
— gated on the same `database.ownerModuleId`/property check the inline call
used. `backend/packages/data/src/domainWriteHooks.ts` is the single
composition point that imports every domain's hook by name and registers it;
it is a side-effect-only module, imported as the first line of
`backend/packages/data/src/index.ts` so every process that loads
`@semprec/data` registers the hooks before any write. A test that imports a
choke-point module by its deep path instead of the barrel must import
`domainWriteHooks.js` itself to see the same behaviour.

The new dependency-cruiser rule `chokepoint-knows-no-domain` forbids any file
under `chokePoint/` (except `schemaCoreModuleManifest.ts`, which legitimately
wires domain route handlers and tools, and `itemTrash.ts`, whose cascade
delete/restore/purge imports are the `itemDeleteWithClient` path deliberately
left without a hook) from importing a listed domain folder directly — `chokePoint/hooks.ts` is the only way across that boundary. The
rule lists domains explicitly, so a new domain must be added to it to be
covered; `scheduler/`, `rollup/`, `views/`, `seed/`, `tasks/` (the
`deriveTaskTime` derivation), `migrationJob/` and the root-level
`systemSettings.ts`/`timezone.ts`/`realtimeHook.ts` are deliberately not
listed — several choke-point modules import them today and moving those is a
different issue's concern.

## Consequences

Adding a domain's transactional side effect to an item or relation-edge write
is now one hook registration in `domainWriteHooks.ts` plus the hook itself
next to the domain's own code — no edit to `chokePoint/itemWrites.ts` or
`chokePoint/relationOps.ts` at all, and the boundary rule keeps a future
direct import from creeping back in. The cost is one indirection: reading
`updateItemWithClient` no longer shows which domains react to a write, only
that hooks run; a reader has to follow `domainWriteHooks.ts` to see the full
list. A test that reaches a choke-point module through a deep import instead
of `@semprec/data`'s barrel must remember to import `domainWriteHooks.js`
itself, or a hook it depends on silently never fires.
