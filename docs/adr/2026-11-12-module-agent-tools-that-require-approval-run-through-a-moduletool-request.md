---
status: accepted
date: 2026-11-12
area: [backend]
supersedes: []
superseded-by: null
---

# Module agent tools that require approval run through a `moduleTool` approval request

## Context

Gh-1791 is the owner of deferred module tool calls named by
[[2026-10-28-module-agent-tools-approval-and-grants]] and
[[2026-11-04-owned-databases-admit-safe-module-agent-tools]]. The second record
leaves tools of the modes `always` and `unlessProjectPermitted` absent from
agent sessions until this owner exists, and says that its "older
requiresApproval-only wording" has to be reconciled with the accepted modes.
[[2026-11-04-mcp-exposes-module-agent-tools]] keeps such tools absent over
`/mcp` and leaves gated execution to this owner.

The approval pipeline had two request kinds: an MCP tool call (`mcpInvoke`) and
a generic operation. The first runs an external call after a claim
([[2026-09-29-exactly-once-execution-of-deferred-mcp-tool-calls]]); the second
compares a resource snapshot and mutates in one locked transaction
([[2026-09-18-exactly-once-execution-of-approved-destructive-operations]]). A
module tool handler is neither: it receives a pool and a run id and opens
whatever transactions it needs, so it cannot run inside the executor's
transaction, and it has no resource the choke point can project.

## Decision

1. **`requiresApproval` is the switch, `approval` stays the classification.**
   `ModuleAgentToolDescriptor` gains `requiresApproval?: boolean` and
   `snapshotExport?: string` (allowed only with `requiresApproval: true`; a
   manifest that sets it without the flag fails validation, and a
   `snapshotExport` that is not a function export fails at module load). A tool
   with `requiresApproval: true` is composed into an agent session whatever its
   `approval` mode is, and calling it creates a `moduleTool` approval request
   instead of running the handler. The modes keep their meaning for
   classification and validation. A tool of mode `always` or
   `unlessProjectPermitted` that does not set the flag stays absent, because
   nothing evaluates the project permission of `unlessProjectPermitted` yet and
   mapping `always` onto the flag is a decision for the owner of the grant rule.
   This is how the older wording is reconciled: the flag is the opt-in, and no
   existing declaration changes behaviour.
2. **Callers opt in to gated tools.** `ModuleRegistry.getAgentToolDefinitions`
   and `resolveModuleAgentToolsForRun` leave a tool with `requiresApproval` out
   unless the caller passes `includeApprovalGated`. Agent session composition
   and the executor pass it. The `/mcp` endpoint does not, so a gated tool is
   absent and unknown over `/mcp` until its owner (gh-1957) creates the request
   there; without the opt-in a tool whose mode is `none` and which also sets the
   flag would run directly over `/mcp`.
3. **The request.** The payload is `{ moduleToolName, args }`; the module is
   resolved from the name through `ModuleRegistry` when the request executes, so
   a deactivated module or a tool the run is no longer offered ends in an error
   outcome (`toolUnavailable`) and the handler does not run. The request stores
   the localisable description `approval.moduleTool {toolName}`, the tool call
   id, the declared risk class (`unclassified` when none), and in
   `resource_snapshot` `{ kind: "module_tool", resourceId: <tool name>, sha256 }`.
   The request carries no argument values on any read: the detail read of one
   request adds them for an `mcpInvoke` request only
   ([[2026-11-12-mcp-argument-values-leave-the-server-only-in-the-owners-request-detail]]),
   so the owner sees a `moduleTool` request through its description and safe
   summary.
   Its `approval_pending` notification goes to the actor of the requesting run,
   the only user who can decide the request, and is linked by source like the
   other kinds. Its safe summary is `{ kind: "moduleTool", toolName, argKeys }`, and the
   Semp thread list reports `moduleTool` as the `sourceKind` of a pending approval raised by it.
4. **The snapshot.** `snapshotExport` has the shape of `handlerExport`:
   `(pool, ruleKinds)` returns `(runId, args)`, which resolves to a JSON value
   describing the source the call would change. A missing source is a value
   (for example `null`), not an error. The request stores the SHA-256 of its
   canonical JSON. Before the handler runs the snapshot is read again and
   compared to the stored hash for equality; any difference, including a hash
   against no snapshot and no hash against a snapshot, ends in a `conflict`
   outcome (`sourceChanged`) and the handler does not run. A snapshot that
   cannot be read ends in a `callFailed` outcome. A tool that declares no
   snapshot is never compared.
5. **Exactly-once means at most once.** The `moduleTool` kind follows the
   `mcpInvoke` state machine: the atomic claim
   (`claimApprovalRequestExecution`), the handler outside any transaction of the
   executor, and an outcome write guarded on the request still being `queued`.
   A second delivery that finds the claim held is retried by the queue; a claim
   whose delivery died is settled by the stale-claim sweep. A handler that
   returns an error result or throws is a terminal `callFailed` outcome, stored
   without its message and logged as the error's class name and code only (never
   the error object: a handler writes user content, and a database error
   carries the offending values in `detail`; logs are not tenant-scoped; the
   same rule applies to a failed deferral in the agent session and to a
   snapshot that cannot be read). It is not retried, because it
   may already have changed part of its source. The snapshot comparison narrows
   the window between approval and execution and does not close it: nothing
   locks the source between the comparison and the handler, so a handler keeps
   its own guards.

## Alternatives considered

- **Derive deferral from the `approval` mode.** Rejected for now:
  `unlessProjectPermitted` needs a permission evaluator that does not exist, and
  turning every `always` tool into a deferred one at once would also change
  declarations that other issues have not yet reviewed.
- **Return gated tools from the default resolution and let each caller
  filter.** Rejected: `/mcp` would run a gated handler directly the day a
  declaration sets the flag, and the filter would have to be remembered by every
  new caller.
- **Run the handler in the transaction that records the outcome.** Rejected:
  module handlers open their own transactions and cannot be enrolled in the
  executor's, and the claim-then-record shape is already the accepted answer for
  work that cannot run inside one.
- **Retry a failed handler.** Rejected: nothing tells a handler that failed
  before changing anything from one that failed halfway, and a replay would
  repeat the part that succeeded.

## Consequences

- Gh-1846, gh-1949, gh-1957 and gh-1840 declare `requiresApproval` and, where a
  stale source matters, a `snapshotExport`; they add no request kind of their
  own. Gh-1957 passes `includeApprovalGated` for `/mcp` when it creates the
  request there.
- The client catalogs need the template `approval.moduleTool` and the existing
  conflict keys; the backend ships the notification body in both locales.
- The stale-claim sweep writes the text it already wrote for MCP requests; the
  text is never exposed (`approvalConflictReason` returns a translation key
  only).
