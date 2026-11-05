---
status: accepted
date: 2026-11-05
area: [backend]
supersedes: []
superseded-by: null
---

# Recording intake coordinates Files identity and transcription

## Context

Gh1574 adds an atomic recording context and enqueue after the shared Files upload
resolves its item. [[2026-11-01-file-uploads-share-the-blob-filing-lock]] keeps the
blob lock during that transaction. Purge instead locks the item before collecting
its blob, so waiting for an existing Files row while holding the blob can invert
that order. The worker uses source Files, transcript and automation locks under
[[2026-11-01-transcription-stop-guards-lock-items-before-automation]].

The partitioned items table has a database/id primary key, not a tenant/id unique
key. The requested recording item FKs cannot reference the specified UUID-only
columns. Migration0118 and the existing item-origin owners already place such
reference validation and purge cleanup at application owners. Do not invent
new global item uniqueness or partition changes for this recording table.

This narrowly extends those decisions and the stream-listener exception used by
Files under [[2026-09-11-module-manifest-custom-routes]]. Their accepted bodies
remain unchanged; the new endpoint does not authorize a fast transcript row or
create-step event wiring assigned to later issues.

## Decision

Use the specified recording_requests columns, tenant-leading primary key, tenant
foreign key/default, classification, strict RLS and ordinary runtime grants.
Item IDs are plain UUID references whose tenant/database/existence integrity is
validated by recordingIntake under RLS, not nonexistent composite item FKs. The
sole writer accepts only the resolved Files item and requested event/time;
name/language/speaker/project columns stay NULL. Purging that Files item removes
its request through existing deleteItemDependents in the same transaction.
Do not claim that direct arbitrary SQL item references are constrained by a FK.

Authenticate and validate headers before storing bytes. Resolve the optional
Event through its tenant's canonical Events database before consuming any body
byte; foreign and unknown IDs have the same fixed404. A requested Event already
in Trash is normalized to no request. Streaming, duplicate-byte cleanup and
normal /api/files behavior retain their existing owner and error precedence.

The callback runs in the existing managed upload transaction while its blob lock
is held. Reserve and re-read the resolved Files row FOR UPDATE NOWAIT before
reading computed.create, requests or queue state. If there is an existing
transcript, reserve it NOWAIT next and recheck the Files checkpoint/binding.
Reserve relevant existing/requested Event rows in sorted ID order NOWAIT after
these item reservations, and recheck liveness under those locks. Reserve the
transcript event definition with its existing try-advisory owner before a new
edge insertion. A physically missing requested Event discovered at recheck has
the same not-found meaning; a now-trashed requested Event becomes NULL. Do not
hold media/provider work or a network stream inside this database transaction.

An actual pg.DatabaseError55P03 from these owned NOWAIT acquisitions or a false
try-advisory gives fixed409 recording_busy, message Recording is busy, without
resource details. Mark the managed owner rollback-only before propagating this
error. All callback failures after shared upload writes also mark rollback-only,
so catching a domain error or rolling back a savepoint cannot commit partial
filing, request, edge or enqueue state. Unknown errors, constraints,40P01,57014
and unrelated domain failures retain their original identity; no whole-body
55P03 remapping, retry or altered timeout. New local error construction needs no
new root-exported error class. /api/files' wrapper keeps its previous behavior.

Under the Files reservation, insert the request ON CONFLICT DO NOTHING and then
read the persisted row. First accepted recorded_at wins, including NULL; a retry does not
rewrite it or rewind completed checkpoints. A previously NULL event_item_id may
receive its first live Event claim under the Files reservation, with a checked
targeted update by the same intake owner. A non-NULL claim is never replaced. A different non-null requested live
Event conflicts with a different persisted non-null request or existing event
edge, including a retained historical association: fixed recording_linked_elsewhere
with the existing same-tenant transcript/event IDs. No silent replacement or
unlink. A NULL request, including a trashed requested Event, does not clear an
existing association. A new recording with that request returns eventId:null;
a deduplicated response projects its existing live association, otherwise NULL.
This refines the fresh-upload201 example without turning a duplicate into201.

When the transcript already exists and has no event edge, link a requested live
Event through the existing relation owner with the fixed transcribe identity,
in this transaction. The same association is a no-op. A trashed existing
transcript is not restored or replaced. Creating a new transcript or wiring its
initial event stays with the later issues. Enqueue only when computed.create is
absent and the existing keyed job lookup finds none. Do not replace an observed
queued/running job or reset its attempts. The Files heartbeat acquires its Files
item reservation before checking recording_requests and enqueue state, so it
serializes with intake and skips an accepted recording row. Keep non-recording
trigger semantics and explicit /api/transcriptions behavior otherwise unchanged.

Prepare retains its existing item-first bracket. In its write transaction,
after Files/transcript reservations and before writing date/checkpoint, read the
current immutable request through its data owner. Use recorded_at, else the
media creation time, else the existing upload-time source. A request accepted
before that write is visible; an already committed prepare checkpoint is not
rewritten by a later duplicate. The recording extension must not add a source-blob lock after its
source-item reservation; media/storage I/O remains outside the transaction.
This decision supplies no cross-request snapshot or global deadlock guarantee.

## Consequences

Same-file contention can now return a bounded409 instead of waiting in the
identified inverse order. Callers may make a new complete request after rollback;
there is no server retry loop. Supported producer, purge and prepare schedules
need real runtime-role overlap controls in both relevant orders, including
actual55P03, rollback-only/savepoint and unchanged prior state/jobs/callbacks.
Test real authenticated upload and task consumption, duplicate/conflicting
Event behavior, unknown/foreign/no-body storage, Trash handling, recorded-time
precedence, heartbeat attempt stability, purge and tenant RLS. Existing MIME
classification and cross-root byte ownership are preserved. Fake gateways and
synthetic history remain explicit limits; this ADR accepts no batch or provider.
