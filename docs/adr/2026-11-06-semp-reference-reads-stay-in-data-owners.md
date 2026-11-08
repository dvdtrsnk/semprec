---
status: accepted
date: 2026-11-06
area: [backend]
supersedes: []
superseded-by: null
---

# Compose Semp reference reads inside the data package

## Context

Gh1684 projects current labels into history, gh1733 expands tenant data for a turn, and gh1623 reloads the calling thread's Inbox card. Many existing data owners are private to packages/data. Exporting every low-level store, querying SQL from services, or using an admin client would widen the public surface and bypass tenancy or stored-shape validation. [[2026-11-06-semp-refs-validate-observed-tenant-state]] explicitly makes refs descriptive, with no new permission or target reservation. [[2026-11-04-owned-databases-admit-safe-module-agent-tools]] retains the module-tool ownership predicate.

## Decision

Use issue-scoped read composition in packages/data. Gh1684's batched label reader stays internal to the history owner; it performs at most one resolver statement per nonempty kind for the returned page, including any joins. It does not load expanded prompt content. Gh1733 exposes one readSempRefContext from semp/sempRefReadContext.ts, called under the turn's trusted tenant scope with a managed client. It composes existing internal item, relation, docs, transcription, Inbox, mail, run and approval readers, including trashed item readers. No low-level reader becomes a public export. A narrowly needed typed read-only join may live in this data composition owner when no existing batched projection provides it. Reuse owner parsing and semantic helpers; do not copy a writer, query from services or create a general registry/port. No schema, lock, isolation, compaction or permission-grant change is introduced.

Current tenant scope and runtime RLS apply to every query, including joins. Validate composite item/database identity before returning content, and do not follow a reference into another tenant. Block state is decoded from a noncreating snapshot/update projection and destroyed in memory. No document is loaded through a creating/locking/compacting writer. Missing optional neighbours are omitted; an unavailable target or read failure is handled per gh1733's per-ref unavailable contract, with no raw content/error logged and no writes. Separate statements observe READ COMMITTED state, without a common snapshot or deletion exclusion. This does not weaken an authorization guard elsewhere.

History recognizes strict unlabeled refs and strict historical labeled refs. Add current resolved data without overwriting a stored label or changing JSONB. Unknown historical objects/nonarrays pass through; unknown entries of mixed arrays get no target query while other recognized entries still resolve. Unknown data is never promoted to an authorized ref. For item/block/transcriptSegment labels, use the item's actual title property, null when missing/null, preserving valid strings including empty strings. Nullable database keys remain null. Their state describes the underlying item; block/range availability is separately checked for expansion. Attachment state describes its own row, with nullable Emails key from its real parent. Present runs/approvals are active regardless of workflow status; absence is purged with null label/key. Run labels contain the first 120 Unicode code points, without ellipsis.

Approval labels are a typed union member carrying the existing validated ApprovalDescription object (key, params and optional endsInheritance), never JSON stringification or fabricated English. Legacy NULL is null; malformed non-null JSON remains corruption. The existing approval-store validator may be named/exported internally for the batch reader, not publicly re-exported. Shared response types describe this shape without importing packages/data. Consumers localize the template themselves; no client rendering is implemented here.

Gh1623 derives thread identity from persisted calling-run data. In the authorization statement join the tenant's actual run, live item thread/Inbox source, current sourceInbox relation and requested live Processing proposal card. A stale/null subject_proposal_id is only a historical hint. Read the effective envelope, history and keys through existing owners on the same managed read transaction. These are point-in-time reads, not a reserved association snapshot. Missing, foreign, random, wrong-card and unlinked/trashed cases give one fixed not-found style refusal. Current module capability/ownership admission is unchanged; no automatic new grants. Attachments have attachmentId and name:null in existing position order because the persisted Inbox attachment has no authoritative filename. Do not invent one from a storage key/UUID/MIME or add a column. No future revision behavior is implemented.

## Alternatives and evidence

Rejected: broad store exports, reverse service imports, inferred filenames, rendered fallback labels, implicit ref grants, or a new cross-domain locking protocol. The cost is a small feature-specific data projection and an explicit structured approval-label response.

Prove labels for rename/move, trash, actual purge, null/empty names and nullable keys; run code-point boundaries including non-BMP text; structured/NULL approval labels; mixed historical context; attachment lifecycle; fifty-message constant resolver query counts. Use non-BYPASSRLS tenant/foreign/random controls. Gh1733's actual service tests prove every ref kind, sibling/context reads, caps and ephemeral model input without expanded task/events. Gh1623 uses the real module registry/handler, current/unlinked/stale hints and no-write controls. Existing publicSurface expectations change only for the one context reader and two named tool exports; shared response types/schema exports are separate. A PASS is restricted to the actual observed scenario.
