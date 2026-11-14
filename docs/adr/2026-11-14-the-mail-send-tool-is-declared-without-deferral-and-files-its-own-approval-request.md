---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# The mail send tool is declared without deferral and files its own approval request

## Context

[[2026-10-28-module-agent-tools-approval-and-grants]] classifies sending mail as risk class `outbound` with approval mode
`always`. [[2026-11-12-module-agent-tools-that-require-approval-run-through-a-moduletool-request]] implements that for a
module tool declared with `requiresApproval`: an agent session never runs such a tool, its call creates a generic
`moduleTool` request holding the arguments, and the handler runs only after a person approved it.
[[2026-11-14-an-agents-mail-send-is-an-approval-request-of-its-own-kind-sent-as-the-user]] gives the agent's send a
request of its own kind (the draft hash, the mailbox and the recipient count) that its own executor sends as the user, and
rejects deferring the send through the module registry. Its consequences say that the agent send tool (issue gh-1949) calls
the send flow with an agent actor and returns the pending request.

The two cannot both hold for the tool `mail.draft.send`. Declared with `requiresApproval`, the session would create the
generic request first and run the handler after it was approved; the handler would then file the request of its own kind,
so the owner would approve one send twice, and the first approval would carry neither the hash nor the description of the
second. Declared with `approval: "always"` and without `requiresApproval`, the tool is absent from every session, because
the registry offers a tool without the flag only when its approval mode is `none`.

## Decision

1. **`mail.draft.send` is declared with `approval: "none"`, without `requiresApproval`, `snapshotExport` and risk
   class** (a tool declared with `approval: "none"` may not carry the risk class `outbound`, and its declared class would
   be the one of a handler that sends). The session runs its handler directly.
2. **The handler never sends.** It reads the run (an unknown run is 404, a run without a project 403), calls
   `requestMailSendApproval` with the run as an `ai_agent` actor (the request `sendDraftEmail` creates for that actor) and
   answers with the sentence of a deferred tool naming the pending request, and returns the request's id as
   `approvalRequestId`. A module tool handler may return that optional field; the session writes it into the tool
   result's `details.approvalRequestId` exactly as it does for a deferred call, because the run-step projection and the
   end-step summary classify and count an approval step by that field alone. It holds no mail transport. The request has the
   risk class `outbound` and is the only thing that can lead to a send: the mail leaves when its owner approves it and the
   executor of the request sends as the user.
3. **The gate of this tool is its request, not its descriptor.** A reader who finds a tool with approval mode `none` in
   the mail manifest must not conclude that a call sends. A test pins that a call of the tool creates a request of kind
   `mail.draft.send` and leaves the draft and the mailbox's Sent folder as they were.
4. **The capability is `mail.send`**, declared by the mail module like `mail.read` and `mail.draft`, so a project holds it
   exactly when it owns the mail databases.

This narrows section 1 and 4 of [[2026-10-28-module-agent-tools-approval-and-grants]] for this one tool: its approval
exists, with the risk class `outbound`, but it is the request of the send and not the deferral of the call. Every other
outbound or destructive tool still takes `always` or `unlessProjectPermitted` with `requiresApproval`.

## Alternatives considered

- **`requiresApproval: true`, `approval: "always"`, risk class `outbound`.** Rejected for the two approvals above; making
  the handler send as the user after the first approval needs mail transports that a handler factory (`(pool, ruleKinds)`)
  does not receive, and the ADR of the request kind rejects that path.
- **Letting the session file the request of its own kind for a tool that names it.** A new descriptor field and a change to
  the session composition and the executor of every module tool, for one tool. Left to a later decision when a second tool
  needs it.

## Consequences

- A caller that exposes tools of approval mode `none` (the MCP exposure of issue gh-1956) exposes this one too, and gets
  the same behaviour: a run credential's call files the request; sending as the user for a human session is that issue's
  decision and does not go through this handler.
- The generic `moduleTool` request of a deferred tool and the request of this tool are different requests; the Semp thread
  list and the queue already treat the request of this tool as a `moduleTool` request ([[2026-11-14-an-agents-mail-send-is-an-approval-request-of-its-own-kind-sent-as-the-user]]).
- A project with `emailSendAutonomous` is treated like any other: the handler reads no project property.
- The handler has no tool call id, so a repeated call of a draft that already has a pending request returns that request,
  and a call after the request was decided files a new one.
