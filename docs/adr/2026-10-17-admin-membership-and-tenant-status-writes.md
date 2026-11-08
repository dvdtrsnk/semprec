---
status: accepted
date: 2026-10-17
area: [backend]
supersedes: []
superseded-by: null
---

# Admin-membership mutations share one lock, and tenant status has one writer

## Context

Admins suspend and reactivate accounts and change roles (#1041), inside the admin plane of
[[2026-10-17-admin-role-without-content-access]]. Two invariants span rows that no single row lock
covers:

- **At least one active admin remains.** "Active admin" is a `users.role = 'admin'` row whose tenant
  (`tenants.status`) is `active`. Two admins demoting or suspending each other lock two different
  rows; each transaction counts the other as an admin and both commit (write skew), leaving none.
- **A non-active tenant gets no new credentials.** `login`, `requestPasswordReset` and
  `resetPassword` decide on the tenant's status and then write a session, a reset token or a password
  hash. A suspension that commits between that read and the write revokes only what already existed,
  and the new session would come back to life on reactivation.

Before this, nothing changed `tenants.status` after provisioning, and later issues add more writers
of the same state: account deletion and the `deleting` status (#1049) and teardown of a tenant that
leaves `active` (#1042).

## Decision

- **One writer of `tenants.status`.** After provisioning, only `transitionTenantStatus` in
  `tenantsStore.ts` changes `tenants.status`: one conditional
  `UPDATE … WHERE id = $1 AND status = ANY($from)` on the caller's client. Zero rows answer 409
  `invalid_account_status` for an existing tenant and `NotFoundError` for a missing one. A new status
  change calls it, not its own `UPDATE`, so the allowed-from check cannot be skipped.
- **One lock for admin membership.** Every mutation that can change who counts as an active admin
  (a write to `users.role`, or a status change of a tenant that has an admin) starts its transaction
  with `lockAdminMembership`, which is
  `pg_advisory_xact_lock(hashtext('semprec_admin_membership'))`. It then reads the target user row
  `FOR UPDATE`, runs `assertAnotherActiveAdminRemains` when the target is currently an active admin,
  and only then writes. The advisory lock is what removes the write skew: both mutations queue on one
  key, so the second counts admins after the first has committed. It is transaction-scoped and
  released at commit or rollback, so no failure path can leak it.
- **Lock order: user row, then tenant row.** The admin mutations lock the user row (`FOR UPDATE`)
  before `transitionTenantStatus` locks the tenant row. A path that issues credentials on the
  strength of the tenant status re-reads it in the same transaction as its write through
  `lockUserTenantBinding`, which takes the user row `FOR KEY SHARE` and then the tenant row
  `FOR SHARE`, in that same order. In READ COMMITTED this gives exactly two outcomes:
  - the suspension commits first, and the credential path's locked read sees `suspended` and
    refuses;
  - the credential path locks first; the suspension's `FOR UPDATE` on the user row waits for it to
    commit, and the suspension's later statements (the session and push revocations) see and revoke
    what it wrote.

  Taking the user row first matters beyond ordering: inserting a session or a reset token takes
  `FOR KEY SHARE` on the user row through its foreign key, so a path that locked only the tenant row
  would deadlock against a suspension holding the user row and waiting for the tenant row.
- **`login` reads before it decides.** `login` reads the tenant binding unlocked for every known
  user, before `verifyPassword`, so a refusal for a non-active tenant runs the same queries as a
  wrong password and its timing does not confirm the password. The locked re-read happens only on
  the success path, inside the session-creating transaction.

## Consequences

- #1049 and any later status change go through `transitionTenantStatus`, take `lockAdminMembership`
  when the target may be an active admin, and lock the user row before the tenant row.
- A new path that writes credentials or tenant-bound state on the strength of the tenant status uses
  `lockUserTenantBinding` in the transaction of that write, not an earlier unlocked read.
- `verifySessionToken` keeps its unlocked read: it writes only `last_seen_at`, and a request already
  authenticated when a suspension commits finishes; the suspension's revocation stops the next one.
- Admin-membership mutations are serialized deployment-wide. They are rare operator actions, so the
  single key costs nothing measurable; a hot path must not take it.
