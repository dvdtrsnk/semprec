---
status: accepted
date: 2026-11-10
area: [backend]
supersedes: []
superseded-by: null
---

# A password change marks the user's reset tokens before and under the user-row lock, and is refused while another transaction holds one

## Context

Issue #1701 adds `changePassword` (`auth/passwordChangeActions.ts`): a signed-in user re-enters the
current password and sets a new one. A reset link requested before the change must answer
`password_reset_token_consumed` afterwards, so the change marks the user's unconsumed rows of
`password_reset_tokens` consumed in the transaction that writes the new hash.

Other transactions lock the same rows:

- `resetPassword` (#142) takes the row of its token first (the `UPDATE` of
  `consumePasswordResetToken`), then the user row `FOR KEY SHARE` and the tenant row `FOR SHARE`
  (`lockUserTenantBinding`), and later updates the user row.
- `requestPasswordReset` takes the user row `FOR KEY SHARE` (`lockUserTenantBinding`) before it
  inserts its token and holds that lock until it commits.
- `suspendAccount` and the account deletions take the user row `FOR UPDATE` and then the tenant row
  ([[2026-10-17-admin-membership-and-tenant-status-writes]]).

The issue lists the steps of the change as: lock the user row `FOR UPDATE`, compare the hash, write
it, revoke the other sessions, mark the tokens. Neither simple placement of the marking works:

- **After the user-row lock, with a waiting `UPDATE`,** it deadlocks with a reset. The reset holds
  its token row and waits for the user row; the change holds the user row and waits for that token
  row.
- **Only before the user-row lock,** it leaves a token usable. A reset request that has inserted its
  token and not yet committed holds the user row `FOR KEY SHARE`. The marking statement cannot see
  the uncommitted token. The change's `FOR UPDATE` then waits for the request, the request commits
  its token and sends the link, and the change commits without having marked it.

The ADR named above also decides that a path which writes credentials on the strength of the tenant
status reads that status again with `lockUserTenantBinding` in the transaction of the write. The
change is such a path: it writes a password hash, and its request was authenticated by the unlocked
read of `verifySessionToken` before the transaction began.

## Decision

`changePassword` verifies the password and computes the new hash first, and then runs these steps in
one READ COMMITTED transaction:

1. **First marking, waiting.** `consumeAllPasswordResetTokensForUser`: one `UPDATE` of every
   unconsumed token of the user. It is the first statement, so while it waits for a token row the
   transaction holds nothing but token rows. A reset that holds its token row is waited for here.
2. **User row.** `SELECT … FOR UPDATE` on the user row. A missing row answers `NotFoundError`.
3. **Tenant status.** `lockUserTenantBinding`, which adds the tenant row `FOR SHARE`. A tenant that
   is not `active` answers `UnauthorizedError`. This is the locked read
   [[2026-10-17-admin-membership-and-tenant-status-writes]] requires, in its order: the user row,
   then the tenant row. It follows step 2 and never precedes it, because two changes that each took
   the user row `FOR KEY SHARE` first would each wait for the other's lock when they ask for
   `FOR UPDATE`.
4. **Hash.** A `password_hash` that differs from the verified one answers
   `ReauthenticationFailedError`.
5. **Second marking, not waiting.** `consumeUnlockedPasswordResetTokensForUser` marks the user's
   unconsumed tokens that no other transaction has locked (an `UPDATE` whose subquery selects them
   `FOR UPDATE SKIP LOCKED`) and then counts the user's unconsumed tokens with a plain read. A count
   above zero answers `ReauthenticationFailedError`.
6. **Writes.** The new hash, `revokeOtherUserSessions` (session rows, then their push registration
   rows) and the successful `login_attempts` row.

A refusal in any step rolls the whole transaction back, the markings of steps 1 and 5 included.

**Why step 5 reaches every committed token.** A transaction can insert a token of the user only
while it holds the user row `FOR KEY SHARE`: `requestPasswordReset` takes that lock itself, and the
foreign key of `password_reset_tokens.user_id` takes it for any insert. `FOR UPDATE` conflicts with
`FOR KEY SHARE`. So when step 2 has returned, every transaction that inserted a token of the user
has ended, and none can insert one before the change ends. Step 5 is a new statement, and under
READ COMMITTED it sees what those transactions committed.

**A transaction that holds a user row `FOR UPDATE` does not wait for a `password_reset_tokens` row
of that user.** `resetPassword` holds its token row while it waits for the user row, so a wait in
the other direction is the deadlock described above. Step 5 is the only statement of the change that
touches token rows under that lock, and it skips the locked ones.

**A token that step 5 had to leave refuses the change.** Such a token was locked by another
transaction when the marking ran: by a reset that consumed it and waits for the user row, or by
another change that marked it in its step 1 and waits for the user row. The count of step 5 sees it
as unconsumed, because that transaction's write is not committed. If the change committed anyway,
the token could be usable afterwards: the reset can still fail and roll its consumption back, and
the other change would be refused at its step 4 and roll its marking back. The answer is
`ReauthenticationFailedError` (403 `reauthentication_failed`), which is what #1701 gives a change
whose password was replaced concurrently, and the caller can send the request again. The rollback
releases the user row, and the transaction that holds the token goes on.

Alternatives considered:

- Committing the change and leaving the locked token to the transaction that holds it. Rejected for
  the two rollbacks named above.
- Waiting for the token with `NOWAIT` or a lock timeout and retrying the transaction. It needs a
  bound on the retries and one more outcome of the route for a change that reaches the bound. The
  refusal needs neither.
- Reversing the order in `resetPassword`. #1701 leaves the reset flow as it is, and a reset learns
  its user from the token row.

## Consequences

- When a change commits, the user has no unconsumed reset token, so every token that was committed
  before the change is consumed. A reset request that waited for the user row issues its token after
  the change, and that link works.
- A change can be refused with 403 although the current password was right: when a reset or another
  change of the same user overlaps it. Of two changes that verified the same password at most one
  commits.
- A suspension or deletion that locked the user row before step 2 is waited for there. Once it has
  committed, step 3 sees the status and the change answers 401. One that reaches the user row later
  waits for the change to end and then revokes the session the change kept.
- Step 1 stays although step 5 would mark the same rows. A change that meets a reset already holding
  its token waits there for the reset to end: it goes on when the reset rolled back and is refused
  at step 4 when the reset committed. A reset that asks for a token step 1 has marked waits for the
  change, and answers `password_reset_token_consumed` when the change commits. Without step 1, a
  reset that holds its token and has not yet locked the user row would refuse the change at step 5
  even when that reset then fails.
- The steps depend on READ COMMITTED: each statement sees what committed while an earlier one
  waited. `changePassword` must not raise its isolation level without replacing this mechanism.
- A new path that marks or consumes rows of `password_reset_tokens` takes them before it locks the
  user row, as `resetPassword` and step 1 do, or under the user-row lock without waiting, as step 5
  does. A new path that inserts a token needs nothing more, because the foreign key takes the user
  row for it.
- This record claims no deadlock freedom beyond the orders above: token rows before the user row
  with a wait, the user row before the tenant row, token rows under the user-row lock without a
  wait, and session rows before push registration rows.
