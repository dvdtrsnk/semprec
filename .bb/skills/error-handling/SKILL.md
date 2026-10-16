---
name: error-handling
description: "How failure paths are written here - never swallow, never map an unknown exception onto a domain error, never let a cleanup failure replace the real one, never report success for work that did not happen. Load this BEFORE writing the catch, not after the happy path already works. Triggers on: catch, finally, .catch(, throw, rethrow, rollback, console.error, NotFoundError, ValidationError, ConflictError, Promise.allSettled, void, a memoized promise, a cleanup in finally, a try around several awaits, a refactor that moves an error mapping, a retry loop, and any branch that decides what happens when something fails. Skip only when the change adds no failure path at all."
---

# The failure path is a feature

Findings cluster here more than anywhere else, and they are rarely about the
happy path being wrong. They are about a failure being turned into silence, or
into a lie about what went wrong.

## Never map an unknown exception onto a known one

```ts
try {
  return await requireUser(id);
} catch {
  throw new ValidationError("user not found");   // wrong
}
```

That block also catches a dropped database connection, a timeout, a bug in
`requireUser` — and reports every one of them to the client as "you sent bad
input". The operator sees a 400 and never looks; the real fault is invisible.

Catch the case you can actually identify (a typed error, a known code) and let
everything else propagate. If you must catch broadly, log the original before
converting it, and never convert an infrastructure failure into a user-facing
validation message.

## Never let the cleanup error replace the real one

```ts
} catch (err) {
  await client.query("ROLLBACK");   // if this throws, `err` is gone
  throw err;
}
```

A `ROLLBACK` on a broken connection throws, and the caller receives the
connection error instead of the error that actually failed the work. Guard the
cleanup so the original error is what surfaces. The same applies to a `catch`
that writes an error status: if the status write fails, the original cause must
still reach the caller.

A cleanup in `finally` (closing a pool, removing a temp file, releasing a lock)
gets its own `try`/`catch` that logs the cleanup failure and drops it. An
unguarded `finally` that throws replaces the primary error just like the
`ROLLBACK` above.

## Never swallow

An empty `catch`, a `.catch(() => {})`, or a `void somePromise()` deletes the
evidence. If a failure genuinely does not matter, that is a claim worth writing
down: log it at the right level and say in one line why it is safe to continue.
A discarded promise is worse than a swallowed error, because it also escapes
the surrounding `try`. That includes `void` on an injected async function you
assume never rejects. You do not control its implementation.

An empty `catch` written to suppress one *expected* throw suppresses every
unexpected one as well. Catch the expected error by type or code and rethrow
the rest.

A memoized promise (`cache ??= load()`) caches a rejection forever. Evict the
entry when the promise rejects so the next call can retry.

## Leave the state consistent

If a run is marked "started" before the work begins, reset it when the work
throws — otherwise the process is permanently wedged in a state no retry
clears. If a lifecycle row is opened, the failure path closes it with an error
status rather than leaving it open forever. Ask of every `catch`: what does the
next run see when it looks at what I just left behind?

## One step, one failure path

A single broad `catch` around several async steps cannot tell a failure before
an irreversible step from one after it. Its handling then contradicts what
already committed: it marks the run failed after the result was delivered, or
retries a write that succeeded. Before writing the `catch`, list each `await`,
mark the ones after which something is committed, and give each segment the
handling its state needs.

Within one failure path, the write that closes the state (marking the run
failed, releasing the claim) comes first. Best-effort extras, such as a
notification or a diagnostic row, come after it in their own `try`, so a
failing extra cannot block the essential write.

Apply a fix for one branch to its symmetric branch too: the error path of a
handler whose success path you just hardened, the second call on the same file
or row.

A refactor or extraction keeps the error contract of what it moves: the same
error types, statuses and bodies. Changing them is a behaviour change, and it
needs its own test and a line in the pull request description.

## Report the failure you had

A step that could not do its work does not report success. Partial success is
its own outcome and belongs in the return value, not in an optimistic status
plus a log line nobody reads.

## Escape hatch

Where the issue's Task explicitly calls for a fallback ("on a parse failure,
skip the message and continue"), implement exactly that — and log the skip, so
the fallback is observable rather than merely assumed.
