---
status: accepted
date: 2026-11-10
area: [backend]
supersedes: []
superseded-by: null
---

# A login replaces the earlier sessions of its installation

## Context

Every login creates a session row. A native app that signs in again on the same device gets a new
row each time, so the list of signed-in devices (#1583) shows one device several times and the old
tokens stay valid until they idle out. Since #1354 a native session records the `deviceId` its
installation sent at login; a web session, and the session of a native client that sends none,
store `NULL`.

Replacing the earlier session (#1687) is an insert followed by an update of other rows. Under READ
COMMITTED two overlapping logins of one installation each insert a row the other's `UPDATE` cannot
see, and both sessions stay active. No row lock closes that gap: the conflicting rows do not exist
when each login decides, and `lockUserTenantBinding` holds the user row only `FOR KEY SHARE`
([[2026-10-17-admin-membership-and-tenant-status-writes]]), which admits any number of logins.

Two alternatives were considered. A partial unique index on `(user_id, device_id)` over unrevoked
rows would refuse the second insert, but sessions created since #1354 may already share a
`deviceId`, so it needs a cleanup migration first, and the losing login would have to catch the
violation and retry. Locking the user row `FOR UPDATE` would serialize every login of the user and
would wait on every transaction that holds a key-share lock on that row through a foreign key.

## Decision

- **Scope of the replacement.** A login whose `device` carries a `deviceId` revokes every other
  unrevoked session of the same user with the same `deviceId`. The `deviceId` is chosen by the
  client and is not a credential, so it identifies an installation only among one user's sessions:
  another user's sessions with the same value are never matched. A login without a `deviceId`
  revokes nothing, because nothing identifies the session it would replace.
- **One transaction.** `login` does this in its success transaction, after `lockUserTenantBinding`
  confirmed an active tenant: it creates the session, calls
  `sessionsStore.revokeSessionsForDevice`, and calls `revokePushSubscriptionsForSession` for each
  revoked id on the same client. A push registration must not outlive its session, so the three
  writes commit or roll back together. Each revocation's realtime event is registered with
  `runAfterCommit` ([[2026-09-10-side-effects-follow-the-commit]]). A rejected login creates no
  session and reaches none of this.
- **One lock per installation.** Before it creates the session, the transaction calls
  `lockSessionDevice`, which takes
  `pg_advisory_xact_lock(2334, hashtext('semprec_device:' || <user id> || ':' || <device id>))`, with
  both ids in the lowercase text form of a `uuid`, so two spellings of one `deviceId` take the same
  key. Of two overlapping logins of one installation the second waits there until the first one's
  transaction has ended. Its `UPDATE` then takes a new READ COMMITTED snapshot, sees the session the
  first login committed and revokes it. The lock is transaction-scoped and is released by commit or
  rollback.
- **A lock class of its own.** The lock is the two-key form of an advisory lock, and its first key,
  the class `SESSION_DEVICE_LOCK_CLASS` (2334), is used by this lock alone. #1687 wrote the
  single-key form `pg_advisory_xact_lock(hashtext(…))`; this decision deviates from that expression.
  The single-key form shares one key space with `hashtext('semprec_admin_membership')`
  ([[2026-10-17-admin-membership-and-tenant-status-writes]]) and every other single-key lock, and
  the `deviceId` is chosen by the client: the holder of an account, who knows its user id, can search
  about 2^32 values for a `deviceId` whose key equals the membership key. A login with that
  `deviceId` would take the membership key after the user row, while an admin mutation takes it
  before that row, and PostgreSQL would break the resulting deadlock by aborting the login or the
  suspension, role change or account deletion. PostgreSQL keeps two-key advisory locks apart from
  single-key ones, and nothing else locks in class 2334, so a chosen `deviceId` can equal only
  another installation key.
- **Lock order.** The user row, then the tenant row (both through `lockUserTenantBinding`), then the
  installation lock, then the replaced session rows, then their push registration rows. `logout`,
  `revokeUserSession`, `revokeOtherUserSessions`, `resetPassword` and `suspendAccount` also write
  session rows before push registration rows, and none of them takes the installation lock. An
  admin mutation takes its advisory lock, the membership key, before the user row, and `login` takes
  the installation lock after it. The two orders cannot close a cycle, because the installation lock
  is never the membership key and only `login` takes it. The transaction that holds the installation
  lock has already locked its user row and tenant row, and what it locks next are session rows and
  push registration rows of its user. A transaction that waits for the installation lock holds only
  its `FOR KEY SHARE` lock on a user row and its `FOR SHARE` lock on a tenant row, and none of those
  writes waits for either.

## Consequences

- When a login with a `deviceId` commits, the session it created is the only unrevoked session of
  that user and `deviceId`. This holds while every writer that creates a session with a `deviceId`
  takes the installation lock (`lockSessionDevice`) before its insert; `login` is the only such
  writer today.
- The second login's correct snapshot depends on READ COMMITTED. Under REPEATABLE READ or
  SERIALIZABLE its snapshot would predate the wait, so `login` must not raise its isolation level
  without replacing this mechanism.
- Sessions that already share a `deviceId` are not cleaned up by a migration. The next login of that
  installation revokes all of them.
- `hashtext` yields 32 bits, so two installation keys can be equal, by accident or because a caller
  who passes an account's password check chose the `deviceId` for it. One of the two logins then
  waits until the other's transaction has ended, as a second login of one installation does. It
  cannot revoke a wrong session, because the `UPDATE` matches on the user and `deviceId` columns.
- An installation key cannot equal a lock another path takes: not a single-key advisory lock (the
  membership key, the AI gateway's budget key, an invitation's key) and not a two-key lock of
  another class (2331, 2332 and 2333). Whatever `deviceId` a login sends, it neither holds nor waits
  for one of those. This holds while no other lock uses class 2334; the comment on the search flush
  classes in `db/pool.ts` lists the two-key classes in use.
- Web sessions are not deduplicated, and neither are sessions of a native client that sends no
  `deviceId`.
