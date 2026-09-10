---
name: state-writes
description: Rules for writing any code that creates, updates, or deletes persisted Semprec state — items, relations, blocks, or rows in any table. Use this skill whenever adding an endpoint, worker, heartbeat handler, migration backfill, agent tool, or any function that mutates the database, even for a "small" internal write or a one-off script. Also use it when reviewing or refactoring existing write paths.
---

# State writes: choke-point, ownership, approval

Three laws govern every write to persisted state in the Semprec backend. They exist
because the whole system's auditability, undo, realtime sync, and AI-safety story
hangs on writes being observable in exactly one place.

Recorded as ADRs: `docs/adr/2026-09-10-choke-point-api-for-state-writes.md`,
`docs/adr/2026-09-10-single-writer-ownership-model.md`,
`docs/adr/2026-09-10-agent-writes-are-proposals-not-direct-writes.md`.

## 1. All writes go through the choke-point

Route every mutation of item/database state through the generic choke-point API
(`POST`/`PATCH /api/items`, the relation endpoint, `confirm`/`revise`) or the data
layer's single write function that backs it. Never issue a direct `UPDATE`/`INSERT`
against item tables from a service, worker, or script.

Why: the choke-point is where idempotency keys, `ifVersion` conflict checks,
`owner`/`locked` enforcement, event emission (WS invalidations, `onItemEvent`
heartbeat triggers), and audit history all live. A write that bypasses it is
invisible to all of them — clients don't refresh, heartbeats don't fire, and the
edit history lies.

The one exception: an issue whose explicit Task is to build or extend the
choke-point itself.

## 2. One owner, one writer

Every piece of state has exactly one owning process (the module contract's
`owner_process` model). Before writing a field, check who owns it:

- `owner: 'user'` fields — written only via user-initiated choke-point calls.
- `owner: 'system'` fields — written only by the single process the module
  contract names. A second process writing the same field is a bug even when the
  value it writes is correct, because two writers drift and the `owner_process`
  check exists precisely to catch that.

If a feature seems to need a second writer, the answer is an explicit ownership
handoff in the module contract, not a quiet extra `UPDATE`.

## 3. Agent code proposes, humans (or grants) confirm

AI/agent code never writes state directly. An agent-originated change is a
*proposal*: it goes through the approval queue / `confirm` flow, where a logged-in
user or an explicit pre-authorized grant turns it into a real write. This
separation of suggestion from write is a core product decision, not a formality —
it is what makes it safe to let agents run unattended.

So when implementing an agent tool or heartbeat that "should update X": create a
proposal card / approval request instead, and let `confirm` do the write inside its
transaction.

## 4. Side effects follow the commit

A write is not visible until its transaction commits, so anything that tells the
rest of the system about it must happen *after* the commit, not inside it:
`NOTIFY`, a WebSocket invalidation, a notification row's push delivery, a queue
job that reads the row back. Fire one inside the transaction and a listener can
act on state that is not there yet — or that never arrives, because the
transaction rolled back after the message was already sent.

Use the transaction's after-commit hook rather than a bare call following the
`await`, and remember that a callback running after `COMMIT` cannot fail the
work any more: if it throws, the caller sees an error for a write that actually
succeeded. Keep those callbacks defensive.

Two related orderings worth checking in the same pass:

- A guard that decides whether to write must run *before* the write, not after
  it. A validity check placed after the insert is not a guard, it is a comment.
- An idempotency check read outside the transaction that protects it is not
  idempotent: two callers both read "not done yet" and both proceed.

## Before committing, check

- [ ] No raw SQL mutation of item tables outside the data layer's write path.
- [ ] Every field written is owned by the process this code runs in.
- [ ] No agent/LLM-driven code path reaches a write without approval/`confirm`.
- [ ] New write behavior has a test exercising the choke-point route, not the
      internals.
- [ ] Every notification, invalidation or enqueue fires after the commit, not
      inside the transaction.
