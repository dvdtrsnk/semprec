---
status: accepted
date: 2026-10-18
area: [backend]
supersedes: []
superseded-by: null
---

# A rejected shutdown logs fatal, and a mail-send failure never logs its error object

## Context

[[2026-09-13-shared-structured-process-logging]] introduced the shared logger and
`installFatalHandlers`, which write one `fatal` record and exit non-zero on an uncaught
exception or an unhandled rejection. The log-level comment in
`backend/packages/shared/src/logger.ts` then said `fatal` is written exclusively by those
handlers.

Issue #1077 moved the remaining `console.*` calls onto the shared logger. Two of its
instructions needed a decision that no ADR recorded:

- Each service's `registerShutdownSignals` catches a rejected `shutdown()` and calls
  `process.exit(1)`. The issue gives this path the same shape as `installFatalHandlers`:
  `logger.fatal({ err, signal }, ...)`. That contradicted the "exclusively" in the shared
  comment.
- The password-reset mail send runs after commit, and its failure is only logged. The issue
  lists `{ err }` for that log line, and it also says that no converted call logs an email
  address. An SMTP refusal can carry the recipient in the error's `message`, `response` or
  `rejected` fields. The shared `err` serializer writes every enumerable field, and it
  redacts secret-shaped text, not addresses. `tenancy/invites.ts` already logs its mail
  failure as the error's class name and SMTP code only, for this reason.

## Decision

1. `fatal` is the level for a failure the process is about to exit on. It is written in two
   places: the shared fatal handlers, and a service's `registerShutdownSignals` when
   `shutdown()` rejects, immediately before `process.exit(1)`. Any other failure logs at
   `error` or below. The rejected-shutdown record is `fatal` because the process ends right
   after it, as it does after the shared handlers' record. An `error` record would look like
   a failed request in a process that keeps running.
2. A log line for a failed outbound mail send never passes the error object. It logs the
   error's class name and its SMTP code (`errorName`, `errorCode`, and `responseCode` where
   the call site has one), plus the identifiers in scope. The reason is that the error can
   carry the recipient's address, and logs are not tenant-scoped. This is the issue's own
   rule that no call logs an email address, and it takes precedence over the `{ err }` field
   list the issue gave for `passwordResetActions.ts`.

## Consequences

- The log-level comment in `backend/packages/shared/src/logger.ts` names both `fatal`
  writers and cites this ADR.
- A new process type with its own `registerShutdownSignals` logs a rejected shutdown at
  `fatal`.
- Every mail-send failure log builds its error fields with `describeMailFailure`
  (`backend/packages/data/src/mail/describeMailFailure.ts`) and adds its own identifiers:
  `inviteId` in `tenancy/invites.ts`, `userId` in `passwordResetActions.ts`. A new call site
  does the same. A test for it uses a refusal that names the recipient and asserts that the
  address is absent from every logged argument.
- An operator who needs a mail failure's full SMTP text has to reproduce it. The log line
  does not contain it.
