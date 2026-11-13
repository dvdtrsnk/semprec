---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# A heartbeat write tool's approval request carries its own description, which shows what it will write

## Context

[[2026-11-12-module-agent-tools-that-require-approval-run-through-a-moduletool-request]] decision 3 stores the
description `approval.moduleTool {toolName}` in a `moduleTool` request and exposes no argument values on any read, so the
description is all the person sees when deciding. For a tool that only names itself this was enough. For
`heartbeat.create`, `heartbeat.update` and `heartbeat.setEnabled` (gh-1846) the arguments are the effect: the task of an
automation is the instruction an agent runs on every tick with the project's grants, and an approver who cannot read it
cannot tell a harmless automation from one that forwards data. The same ADR's Consequences say that tools which add a
snapshot add no request kind of their own; they still need a way to supply their description.

## Decision

1. **A module tool may supply its own description template. For now the mechanism is a switch in the request writer.**
   `createModuleToolApprovalRequest` calls `buildHeartbeatToolApprovalDescription` in the request's transaction and uses its
   result in place of `approval.moduleTool`; the builder returns `null` for every other tool name. A tool adds a `case`
   to that switch, or a sibling builder called the same way, and the keys and params are listed in the header of
   `mcp/approvalDescription.ts`. This narrows decision 3 of the 2026-11-12 record to the tools that have no builder.
2. **The builder may refuse.** It runs on the transaction client, so it reads the run's scope and the target rows as the
   request sees them. A `NotFoundError` or `ValidationError` it throws rolls the request back, so a call the person
   would not be allowed to approve never reaches them
   ([[2026-11-13-the-approval-gated-heartbeat-write-tools-share-the-read-scope-of-the-heartbeat-tools]]).
3. **The description shows what will be written, in the form that will be stored.** For `heartbeat.create` and
   `heartbeat.update` that is the new name, the rule as `parseHeartbeatRule` returns it (extra keys the model sent are
   dropped; a rule of a module kind, whose handler the builder cannot see, shows its `kind` alone) and the task. The
   rule is cut at 300 characters and the task at 500 characters, each with a marker where it is cut, because the
   description is a stored snapshot that is also rendered into the `approval_pending` notification body. Values are
   shown as JSON strings so they cannot pose as part of the sentence around them.
4. **Params are localised by the tenant user's locale** (`getTenantUserLocale`); the catalogs are
   `seed/i18n/{cs,en}.json` and `notifications/i18n/{cs,en}.json`.

## Alternatives considered

- **A manifest-declared hook** (a `descriptionExport` beside `snapshotExport`), which would let `mcp/` stop importing a
  scheduler file. Not adopted now: it changes the descriptor, its validation and module loading for three tools of one
  owner, and the builder needs a database client and the system catalogs of the seed, which a module export does not
  have today. When a second owner needs a description, that change replaces the switch and supersedes decision 1.
- **Keep `approval.moduleTool` and the tool name.** Rejected: the approval would not convey the effect of the write.
- **Show the whole task.** Rejected: it is unbounded in the notification body and the snapshot; a fixed excerpt with a
  marker keeps both bounded, and the person can open the automation to read the rest.

## Consequences

- gh-1949, gh-1957 and gh-1840 that need a description of their own add a case here or supersede decision 1 with the
  hook; they do not fork `createModuleToolApprovalRequest`.
- A task longer than the excerpt is approved on its first 500 characters; the marker says so. A longer limit is a change
  of this record.
