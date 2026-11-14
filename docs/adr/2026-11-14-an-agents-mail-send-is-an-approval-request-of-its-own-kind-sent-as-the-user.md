---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# An agent's mail send is an approval request of its own kind, sent as the user after the approval

## Context

[[2026-10-28-module-agent-tools-approval-and-grants]] decides that a send by an agent or by an MCP client with a run
credential creates an `outbound` approval request instead of a 403, also in a project that holds `emailSendAutonomous`,
and that a human session sends as the user. Until issue gh-1913 `assertEmailSendAuthorized` in `mail/send.ts` still let
an agent through when its project held the permission and refused it otherwise.
[[2026-11-12-module-agent-tools-that-require-approval-run-through-a-moduletool-request]] defers a module tool through a
`moduleTool` request whose payload is the tool's arguments and whose executor looks the tool up again in the module
registry. [[2026-09-29-exactly-once-execution-of-deferred-mcp-tool-calls]] fixes the claim, external call and
record-outcome protocol of a request that calls something outside the database.

A send differs from a module tool in what the approval must pin. The approver is shown a mailbox and a number, never the
recipients, the subject or the text, so what they approve is a draft, and a draft can be edited after it is approved.

## Decision

1. **An agent never sends, whatever permission its project holds.** `sendDraftEmail` looks at its actor first. For an
   `ai_agent` actor (`{ agentRunId, toolCallId? }`) it creates the request below and returns it; it reads nothing of the
   input but `draftItemId` and the actor, and reads no project, thread or heartbeat, so `emailSendAutonomous` on the run's
   project, on the draft's thread or on a heartbeat's project, and a project written on a thread by an agent or by Semp's
   sorting, change nothing. A `user` actor, which also stands for an MCP client with a human session, sends as before.
   `assertEmailSendAuthorized` is removed.
2. **The request is of its own payload kind and belongs to the `moduleTool` family.** The tool is `mail.draft.send`, the
   risk class `outbound`, and the payload `{ draftId, draftHash, mailboxId, to, subject, body }`
   (`MailSendApprovalRequestPayload`). It is a `moduleTool` request for every reader that sorts requests by kind (the
   queue's safe summary and the Semp thread list's `sourceKind`), and its source (`chat`, `tick` or `mcp`) is derived from
   the run as for every request. It is not executed through the module registry: the registry resolves a tool and runs it
   with arguments, and the send must instead be compared with the stored draft before anything leaves.
3. **The request describes the stored draft.** `requestMailSendApproval` reads the draft with `prepareSend`, which takes
   the Emails item lock and then the `mail_drafts` row lock (the order of
   [[2026-11-13-a-discarded-mail-draft-loses-its-row-and-draft-writers-lock-the-item-before-the-row]]). The payload, the
   hash and the description are built from what it read, never from what the caller supplied. `draftHash` is the SHA-256 of
   the canonical JSON of the mailbox, From, To, Cc, Bcc, subject, text body and attachments (file name, content type and
   blob id). The description is `approval.emailSend` with `{ mailboxName, recipientCount }` and holds no recipient, no
   subject and no text; the stored payload does, and no client-facing view returns it.
4. **A draft has at most one pending request.** While the creating transaction holds the item lock, it looks for a
   pending request of the draft and returns it when there is one. The lock orders two concurrent creations, so the second
   sees the first's request; nothing else enforces the rule, and no unique index backs it. A request that was decided no
   longer counts, so a rejected request can be followed by a new one.
5. **Execution sends as the user, and only the approved draft.** The `approvalExecute` job claims the request
   (`claimApprovalRequestExecution`) and hands it to `executeClaimedMailSendApproval`. It reads the draft again and
   computes the hash; a draft that is gone, sent, without a recipient or without a draft row, or whose hash differs, ends
   the request in `conflict` (`sourceChanged`) and nothing is sent. It then calls `sendDraftEmail` with a `user` actor,
   the owner's approval being the authorization, and its `beforeClaim` guard computes the hash a second time in the claim
   transaction under the locks, so a draft edited between the first read and the claim is not sent. A claim that another
   send holds is `sourceChanged` as well. Any other failure is `callFailed`, logged by class name and code only, and the
   request is not retried; a failure before the provider took the message leaves the draft sendable, because
   `sendDraftEmail` undoes its claim, and one after it leaves the claim, so the draft cannot go twice. A claim whose delivery
   died is settled by the stale-claim sweep of the exactly-once ADR, and the mail is not sent by a later delivery, so the
   send is at most once. The worker sends through the transports its task list was given (`createCoreTaskList`'s
   `mailSendTransports`); without them the request ends in `toolUnavailable`.
6. **Deciding a request closes the draft's other pending requests as superseded.** In the decision transaction
   (`decideAndEnqueueApprovalRequest`), whichever way the request was decided, every other pending mail send request of the
   draft becomes `rejected` with no decider and its execution result `{ supersededBy }`. It never executes; its
   notification is resolved, its thread is told it was rejected and its owner is told it changed. Creation returns the
   draft's pending request, so this closes nothing in the normal case and covers a request that reached the table by
   another path.

## Alternatives considered

- **Defer through the module registry with the tool's `{ draftId }` as arguments.** Rejected: the executor would run the
  tool's handler as an agent with whatever the draft holds then, and the request would carry no recipients, subject or
  hash to compare. The snapshot of that path compares one hash, which here would have to be computed from the same read
  that builds the send, and the handler would need to send as the user although it is called by an agent tool.
- **A partial unique index on the pending request of a draft.** Rejected for now: it needs a migration and an arbiter on
  the insert, and the item lock already orders every creation. The rule holds for the creators that take the lock.
- **Show the recipients and the subject in the description.** Rejected by the product owner: a description is stored,
  searched and pushed, and never carries argument values.

## Consequences

- The agent send tool (gh-1949) and the MCP exposure (gh-1956) call `sendDraftEmail` with an agent actor and return the
  pending request; neither adds a permission check.
- The owner's request detail does not show the recipients or the subject yet: the detail of a `moduleTool` request is
  value-free ([[2026-11-12-mcp-argument-values-leave-the-server-only-in-the-owners-request-detail]]), and showing them
  needs its own change to that read.
- The client catalogs need the template `approval.emailSend` (the backend ships it in `seed/i18n` and the notification
  catalogs) and the conflict keys that already exist.
- `emailSendAutonomous` and `GET /api/mail/autonomous-send-projects` stay as they were, and no send reads them.
- The seeded guidance of the Email project says that an agent send is queued for approval whatever the grant says. The
  seed leaves an existing guidance row as it is, so an account created before this change keeps the old text (a 403
  without the grant) until its owner edits it; rewriting owner-editable rows is left to a separate backfill.
