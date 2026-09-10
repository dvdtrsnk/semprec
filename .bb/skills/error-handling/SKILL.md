---
name: error-handling
description: How failure paths are written in the Semprec backend — never swallow an error, never map an unknown exception onto a domain error, never let a secondary failure replace the primary one, and never report success for work that did not happen. Use this whenever writing or changing a catch block, an error mapping, a rollback path, or any code that decides what happens when something fails.
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

## Never swallow

An empty `catch`, a `.catch(() => {})`, or a `void somePromise()` deletes the
evidence. If a failure genuinely does not matter, that is a claim worth writing
down: log it at the right level and say in one line why it is safe to continue.
A discarded promise is worse than a swallowed error, because it also escapes
the surrounding `try`.

## Leave the state consistent

If a run is marked "started" before the work begins, reset it when the work
throws — otherwise the process is permanently wedged in a state no retry
clears. If a lifecycle row is opened, the failure path closes it with an error
status rather than leaving it open forever. Ask of every `catch`: what does the
next run see when it looks at what I just left behind?

## Report the failure you had

A step that could not do its work does not report success. Partial success is
its own outcome and belongs in the return value, not in an optimistic status
plus a log line nobody reads.

## Escape hatch

Where the issue's Task explicitly calls for a fallback ("on a parse failure,
skip the message and continue"), implement exactly that — and log the skip, so
the fallback is observable rather than merely assumed.
