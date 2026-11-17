# Agents, approvals and AI

Who an agent is, what it may read and write, how its writes become proposals and approval requests, how sensitive
data is kept from models and stored history, how model calls go through the AI gateway, and how Semp chat and voice
run. See also [data-model-and-writes.md](data-model-and-writes.md), [transactions-and-side-effects.md](transactions-and-side-effects.md),
[tenancy-and-security.md](tenancy-and-security.md), [edges-io-and-errors.md](edges-io-and-errors.md).

## Actors and agent identity

| Actor | Carries | Approval gate | Per-database grants |
|---|---|---|---|
| REST user session | `userId`, `restSession` | never | not checked |
| Agent run (AgentTool) | `userId`, `runId`, `agentProjectItemId` | yes | yes, on the run's project |
| `/mcp` restricted run credential | same as a run | yes | yes, on the run's project |
| `/mcp` human token ("external client") | `userId`, `externalClient: true` | no | sensitive databases always refused |
| System | `SYSTEM_WRITER` | never | not checked |

- The writer of a choke-point write is a `WriterIdentity` (`backend/packages/data/src/chokePoint/writerKind.ts`).
  `agentProjectItemId` and `externalClient` are never set together. No input schema accepts any of these markers;
  only the composition roots set them (`restActor` for REST, `resolveActor` in
  `backend/services/semprec-api/src/mcp/mcpHandler.ts`, the AgentTool composition root).
- Every choke-point call that records or checks `ai_agent` ownership first calls `assertAuthenticatedAgentIdentity`
  (`backend/packages/data/src/chokePoint/authorization.ts`): an agent actor without `agentProjectItemId`, or whose id
  is not a live Projects item, is refused `403 owner_violation`. Any future column storing an agent identity is
  verified the same way, fresh on every mutating call (items are partitioned, so no FK can do it).
- Writes of an `/mcp` client on a human token are recorded as `writerKind: 'agent'` without run ids, so agent audits
  include them.
- `humanWriterUserId` reaches item create/update hook contexts only for a `restSession` actor without
  `agentProjectItemId`. A `stdio` MCP server config (a host command) may be stored only when that human is an admin of
  the current tenant (`tenantAllowsStdio`, `backend/packages/data/src/mcp/stdioTransportPolicy.ts`,
  `mcpServerWriteHook.ts`); agents, `/mcp` clients and proposals never qualify, and proposal validation refuses
  `transport: "stdio"` outright, again at confirm. The spawn re-checks the policy.

## Agent writes are proposals

### The rule

- Agent code never writes user-owned domain state directly. It creates a proposal (a Processing proposals card) or an
  approval request; a person's confirm or approval performs the write in its own transaction. An agent calling a
  write endpoint or the data layer outside the paths below is a high-severity review finding.
- The only door for agent writes is `createGenericOperationGateway` (`backend/packages/application/src/genericOperationGateway.ts`)
  plus the module agent tools below. `semprec-agents` connects as `semprec_data` for that reason; direct SQL writes to
  choke-point tables are prohibited everywhere.
- Cancelling an agent turn never decides an approval request; a pending request stays pending.

### Closed list of direct agent writes

1. Generic operations whose `OPERATION_METADATA[op].requiresApproval` is `false`
   (`backend/packages/shared/src/genericOperations/capabilities.ts`), unless the write is flagged (below). The test for
   a new operation: a later write through the same catalog trivially undoes it. A hard delete, external side effect or
   send-once action is `requiresApproval: true`. Classification lives only in `capabilities.ts`.
2. An agent's own views and their curated membership (`chokePoint.createView`/`patchView`/`deleteView`/view items),
   restricted to the agent that created them via `views.creator_project_item_id`. No other resource inherits this.
3. A job's own diagnostic bookkeeping and the notifications describing what it observed (`agent_run_error`,
   `heartbeat_error`, guidance drift findings). It writes only tables it owns; it never edits guidance, permissions or
   other user-owned state.
4. `page.insert`: additive, blocks authored `ai_agent`.
5. Module agent tools classified `approval: "none"` (reads, writes through non-destructive generic operations, drafts
   nothing sends, and the guarded `heartbeat.trigger` on the run's own project).

### Destructive generic operations

`database.archive`, `property.delete`, `view.delete`, `item.delete`, `relation.delete`, `page.replace`,
`page.restoreVersion`, `page.mergeJournalDuplicates`, `page.convertToBlock`. An agent call with a run queues a pending
`approval_requests` row and returns `ApprovalRequiredError` (JSON-RPC `-32001` over `/mcp`). REST users execute them
directly. The approval risk label comes from `deriveApprovalRiskLevel`: a `destructive` op is `irreversible` unless its
metadata says `reversible`.

### Flagged agent writes (value-link breaks)

- A non-destructive agent write with a run is deferred when the choke point flags it inside its own transaction: the
  write rolls back and an approval request with a resource snapshot is created. User, system and human-token `/mcp`
  writes are never deferred.
- The one flagged case: a write that turns an `on` value link into a broken one (`item.patch` of a linked key with a
  different value, `relation.put` inserting an edge on a linked side, `relation.set` removing an edge on a linked side,
  `link.unlink` of an `on` link). Risk class `breaksLink`, description `approval.breaksLink`, lists `breaksLinks` and
  `endsInheritance` (`backend/packages/data/src/mcp/approvalBreaksLink.ts`, `chokePoint/valueLinkApproval.ts`). The
  choke point share-locks the `on` links it decided on.
- `item.create` with initial relations that would break a link cannot be deferred, so it is refused with
  `validation_failed`; the agent uses `relation.put`.
- The approved replay passes server-only `approvedRequestId` on the writer for that one mutation so the flag lets it
  through; it is not client input and does not propagate to nested writes. Hooks stay active.
- Value-link propagation runs at most five hops per initiating change (hop budget in an `AsyncLocalStorage` context,
  queue key `ruleKey + sourceItemId + hop`); hop six is dropped and logged.

### Module agent tools

- Every `ModuleAgentToolDescriptor` declares `approval: "none" | "always" | "unlessProjectPermitted"` and an optional
  `riskClass` from the closed `RISK_CLASSES` set (`unclassified`, `read`, `write`, `destructive`, `outbound`,
  `breaksLink`). Omission is a manifest validation error, never a safe default. Mode `none` admits only no class,
  `read` or `write`. A tool reaching several classes takes the strictest.
- `requiresApproval: true` is the switch that composes a tool as approval-gated: calling it creates a `moduleTool`
  approval request (payload `{ moduleToolName, args }`) instead of running the handler. An optional `snapshotExport`
  returns a JSON description of the source the call would change; its SHA-256 is stored and compared before the
  handler runs (`backend/packages/data/src/mcp/moduleToolApprovalRequest.ts`, `moduleToolApprovalExecution.ts`).
- `ModuleRegistry.getAgentToolDefinitions` / `resolveModuleAgentToolsForRun` omit gated tools unless the caller passes
  `includeApprovalGated` (agent sessions and the executor do).
- A module tool appears in a run only when the run's project holds its capability (below); an ungranted tool is
  absent, never listed-and-denied, and never produces an approval request.
- A module tool's validated returned error (`details.error: true`) reaches the model as an ordinary tool error
  (`isError: true` via pi `afterToolCall`); only thrown infrastructure failures abort the session.
- A tool that needs its own approval text supplies a description builder called inside the request transaction
  (`buildHeartbeatToolApprovalDescription`); it may refuse (rolling the request back) and shows what will be stored,
  bounded (rule ≤300, task ≤500 characters, with a cut marker, values as JSON strings).

### Mail send

Every send by an agent run or a run credential creates an `outbound` approval request
(`requestMailSendApproval`, `backend/packages/data/src/mail/mailSendApproval.ts`); no project property, including
`emailSendAutonomous`, lets mail leave without approval. A human session (REST or `/mcp` human token) sends directly.
The project set on a mail thread never takes part in a send decision.

## Approval requests

### Execution: approved operations run exactly once

- `handleApprovalRequestExecuteTask` (`backend/packages/data/src/mcp/approvalRequestExecution.ts`) dispatches by kind.
- Generic operation: `ApprovedOperationExecutor` row-locks the request, recomputes the resource projection, compares it
  with the stored snapshot, performs the one mutation and writes the terminal state in the same transaction. Drift or
  an authorization refusal is a terminal `conflict` before mutation; a mutation-stage failure rolls back and leaves the
  request `queued` for the queue's retry.
- `mcpInvoke` and `moduleTool` (external work that cannot run in a transaction): claim
  (`claimApprovalRequestExecution` commits `executed_at`), call outside any transaction, then
  `recordApprovalRequestOutcome` guarded on `execution_status = 'queued'`, which returns `false` when the row is
  already terminal (callers must treat that as expected). A claim older than 10 minutes is settled to `conflict` with
  an "unknown outcome" marker by `settleStaleApprovalRequestClaim`; a younger one is retried. `mcpInvoke` forwards the
  request id as `_meta.idempotencyKey`. A failed module handler is a terminal `callFailed`, never retried; the module is
  re-resolved at execution (`toolUnavailable` when gone), and a changed snapshot ends as `conflict` (`sourceChanged`).
- Logged failures carry only class name and code, never the error object or message.
- Approval requests are not undoable through proposal undo; an executed action is reversed by a restore or a new change.

### Snapshots and reservations

- A request's `resource_snapshot` is `{ kind, resourceId, sha256 }` computed by `buildResourceSnapshot`; projections
  live with the resource owner (`chokePoint/destructiveProjection.ts`, `computePageRestoreProjection` in
  `docs/docPageRestore.ts`, page replace/convert projections). The preflight rehearses the operation's refusals; a
  refused call creates no request. Grants are checked in the projection at request time and again at replay.
- Projections reserve their inputs without waiting (`NOWAIT`, `tryLockRelationDefinition`); a held lock is
  `ApprovalResourceBusyError` (409 `approval_resource_busy`), which marks the transaction rollback-only and leaves an
  approved request queued for retry. Only genuine `55P03` / false try-lock map to busy.
- Lock orders that must be kept:
  - relation put/set: relation-definition advisory, property/definition/database rows `FOR SHARE NOWAIT`, endpoint
    item rows (stable order), source edges `FOR UPDATE NOWAIT`, then `on` links;
  - relation delete: endpoint item rows (by database id, item id), then `on` links;
  - page restore replay: approval request row, `agent_run` row, document lock (`doc_snapshots` row).
- `item.patch` break-link snapshots cover the affected links and the linked properties' stored values, not the whole
  item, unless the owning module contributes its own patch snapshot.

### What a request shows

- Descriptions are localisable `{ key, params }` (`approval.*`, `backend/packages/data/src/mcp/approvalDescription.ts`)
  and never contain argument values. Notification bodies append "This can be undone later." only when the application
  itself can undo the action (generic `reversible`); an external MCP request always gets "Semp cannot undo this
  action."
- MCP argument values leave the server only in `GET /api/approval-requests/:id` read by the request's owner, for
  `mcpInvoke` only, produced by `toApprovalRequestArgumentValues` (`backend/packages/data/src/mcp/approvalRequestArguments.ts`):
  key-name redaction (`password`, `secret`, `token`, `apikey`, `api_key`, `authorization`, `cookie`, `credential`),
  depth 32, strings ≤2000 code units, JSON ≤16 KiB with whole entries dropped before containers are cut,
  `argumentsTruncated`. Lists, counts, `PATCH` answers, notifications, push and search are value-free. Widening this is
  a new decision.
- The `approval_pending` notification goes to the actor of the requesting run.

## Grants and sensitive data

### Capabilities and MCP grants

- Capabilities (`CAPABILITY_IDS`) are properties of a run, computed per project by `generatePermissionManifest`
  (`backend/packages/data/src/manifest/permissionManifest.ts`). `core.page.read`/`core.page.write` are registered but
  never auto-granted and no operation requires them; page operations use the item capabilities.
- A non-core module capability is granted only when every database the module declares exists, is live, owned by the
  run's project and writable. Activation is never a grant.
- `project_mcp_grants` has exactly one writer: `setProjectMcpGrant` (`backend/packages/data/src/mcp/mcpGrantsAdminStore.ts`,
  off the package's public surface) reached only by `PATCH /api/projects/:projectItemId/mcp-grants/:mcpToolRegistrationId`.
  Confirm routes, sync jobs, agent tools, `/mcp`, credentials and heartbeats never grant; an MCP card's project
  selection only pre-fills read-class tools on the client. A grant decides visibility, approval decides execution.
- `mcp_tool_registrations.risk_class`/`requires_approval` are owned by the annotation sync
  (`classifyMcpToolFromAnnotations`, `upsertClassifiedMcpToolRegistration`) while `classification_source =
  'annotation'`, and by a person once a person sets either (`manual`, one way). Mapping: `readOnlyHint` → `read`, no
  approval; else `destructiveHint` not explicitly false → `destructive`; else `openWorldHint` explicitly true →
  `outbound`; else `write`; no annotations → `unclassified` with approval.
- `display_label` is user-owned; `suggestMcpToolLabels` fills only `display_label IS NULL` (condition inside the
  `UPDATE`), only a complete `{cs, en}` pair, after a successful sync, never failing it.

### Per-database grants

- `agent_database_grants` (tenant, project item, database, access `none|read|write`) decides an agent project's access
  (`backend/packages/data/src/agentGrants/`). Defaults: a non-sensitive system database is always `write` (rows
  ignored); a sensitive database without a row is `none`; a user-created database without a row is `write`. Only
  `agentDatabaseGrantsAdminStore.ts` writes rows (user routes), plus item purge cleanup in `deleteItemDependents`.
- `assertAgentDatabaseAccess` runs in the transaction of the guarded read or write, locking the decision row
  `FOR SHARE`, so a revoke of an existing row waits for passed checks. Never pre-check in the gateway.
- Guarded paths: item get/list/query/view query, relation list, item create/patch/delete/restore (cascade databases
  too), relation writes (both endpoints), link unlink/relink, `database.get` (refused `forbidden`), `database.list` and
  the schema projection (omit), curated views (omit from page, cursor and count), page operations
  (`assertAgentPageAccess`, owner resolved by `resolvePageOwnerDatabase`: an item's own database, or a subpage's root
  host), transcript module tools. Relation targets and breadcrumb ancestors in unreadable databases come back as
  `{ id, hidden: true }`.
- A new path that exposes database content to an agent must call the check or the list of unreadable databases, or it
  is a leak.

### Sensitive databases

- `databases.sensitive` is set for `SENSITIVE_DATABASE_KEYS` (Health records, sleep settings, plans, nights,
  `backend/packages/data/src/seed/sensitiveDatabaseKeys.ts`) and is monotonic: no code turns it off. Redaction relies
  on that; making it reversible requires capturing classification inside the operation instead.
- Inherited sensitivity: an item of a `SENSITIVITY_INHERITING_MODULE_IDS` database (Files, Transcripts, Inbox) with a
  live relation edge to a sensitive item is treated as sensitive for an agent (`inheritedSensitivity.ts`); not
  transitive. Single-item access needs the access on every linked sensitive database; lists omit such items in SQL
  (`inheritedSensitivityDeniedSql`); refusals do not name the linked record.
- An agent without read access to a sensitive database may not filter, sort, group, facet or aggregate over it:
  `compileFilterNode` refuses relation/path/rollup conditions reaching a closed database, `assertNoSortOverClosedRollup`
  refuses such sorts, and `hideClosedRollupValues` returns `{ value: null, hidden: true }` for those rollups
  (`listClosedSensitiveDatabaseIds`).
- External `/mcp` clients on a human token: every sensitive database is `none`, everything else open, on every path
  above plus counts, facets, property, view, database and page operations. There is no permission that opens it.
  Human REST is unchanged.
- Per-turn read allowance: items the user attached to a Semp message (`item`, `block`, `transcriptSegment` refs, read
  from the persisted refs) are inserted into `agent_run_read_allowances` at turn start and deleted when the turn
  settles (`backend/services/semprec-agents/src/sempTurnReadAllowances.ts`). The check honours it for a `read` of that
  item only, after the project's access refused; never for writes, lists or related items.
- Heartbeat read scope (`resolveHeartbeatReadScope`): a run on a Semp `chat` thread reads every project's heartbeats,
  minus those of a project holding a sensitive grant the caller lacks (`SENSITIVE_PROJECT_HEARTBEAT_EXCLUSION`); other
  runs see their own project. The approval-gated `heartbeat.create/update/setEnabled` use the same scope, checked at
  snapshot, description and handler; `heartbeat.trigger` stays own-project; system automations are out of reach. A
  new tool widening a chat run's reach records which exclusion it reuses.

### Redaction of stored agent history

- Content-bearing generic operations mark a result `sensitive: true` when any database whose content the answer
  carries (items, queried database, expanded relation targets) is sensitive or inherits sensitivity. Lookup failures
  count as sensitive. `runAgentTurn` stores such a `tool_result` via `redactSensitiveToolResult`
  (`backend/packages/agent-runtime/src/sensitiveToolResult.ts`): content `[redacted: sensitive]`, `toolCallId` and
  ids kept, `details.changes` values dropped, `details.createdItemId` kept. The live turn sees the real result.
- After a marked result in one `runAgentTurn` call, later `tool_use` arguments and assistant text are stored as the
  marker (`sensitiveTurnRedaction.ts`); `item.create`/`item.patch` arguments targeting a sensitive database are
  redacted from the start, including the preceding assistant `toolCall` blocks. Replay redacts remaining blocks
  (`conversationReconstruction.ts`); compaction runs only on reconstructed history; `agent_runs.result` stores the
  stored form (`runAgentTurnWithStoredForm`). A new content-bearing write must be added to that list.
- `item.patch` change details classify keys from the typed property definitions used by the write itself (a
  module-private enumerable symbol on the result); `longText`, unknown or missing classification yields key-only
  changes.

## MCP

- `POST /mcp` is a hand-rolled JSON-RPC 2.0 transport (`backend/services/semprec-api/src/mcp/mcpHandler.ts`) over the
  same `GenericOperationGateway` as REST and AgentTools; it owns framing and error mapping only. Tools are
  `semprec.<name>`. RPC failures are HTTP 200 with `-32601` unknown/hidden tool, `-32602` bad input, `-32001` approval
  required, `-32000` other `ChokePointError` (with `data.code`); only transport failures use non-200.
- Restricted run credentials (`agent_run_mcp_credentials`, `backend/packages/data/src/mcp/mcpRunCredentialAction.ts`):
  minted behind an authenticated session by `POST /api/agent-runs/mcp-credentials`, one per run, hash-only storage,
  1-hour TTL, valid only while the run is `running`, capabilities intersected with the process set (never widened).
  Resolution is tried before ordinary session auth.
- Module tools over `/mcp` are exposed only to run credentials, only `approval: "none"`, through the same data-owned
  resolver as sessions; gated and non-core-capability tools are absent; hidden and unknown names give the same
  `-32601`. Name collisions with generic operations are detected at listener creation.
- `mcp_server_connection_state` observations are written through a `Pool` (`recordMcpConnectionSuccess/Failure`),
  independent of the caller's transaction, best effort. No business write may use this exception.
- Auth failures are classified from HTTP status observed per operation and correlated with the exact rejected
  operation (`mcpHttpFailureObservation.ts`), never from error text; no body, argument or credential is recorded.

## Proposals (Processing proposals cards)

### Envelope and confirm

- A card stores `{ entityKind, target, properties }` and optionally `operations` (steps `create|update|link` with
  `ref`, `role`, `optional`, `enabled`, relations targeting item ids or `{ ref }`), `pageSections` and `newOptions`
  (`backend/packages/data/src/inbox/proposalEnvelope.ts`, `proposalEnvelopeValidation.ts`). The top level mirrors the
  primary step; exactly one primary; no ref cycles; disabled or unreferenced optional steps are skipped.
- `confirmProposalWithClient` (`inbox/proposalConfirm.ts`) locks the card, writes every enabled step in dependency order
  in one transaction under the user's authority, and is idempotent: an already `confirmed` card returns its stored
  result. Failures roll everything back with 400 naming `ref` and field.
- Update steps carry `before`/`after`. Confirm locks update items (sorted), then relation-definition advisory keys
  (sorted), then incident edges, and compares preconditions immediately before each write. Proposal validation uses
  read-only preparations registered next to each pre-write transform (`prepareUserItemPatch`); a transform without a
  preparation fails closed; deferred allocations (Projects `pinnedOrder`) declare `before` only. The tenant time zone
  is passed to preparations by the managed caller (`readProposalTimezone`).
- Computed update steps get `before` values from the server's own reads after the model call, never from the model.
- `pageSections` (single-step `database` envelopes only, ≤4 sections, plain text, never Markdown) and `newOptions`
  (≤3 select options, created at confirm through `propertiesStore.addPropertyOption` in the confirm transaction) are
  carried over by revise when the destination is kept. Options survive undo.
- Confirmed blocks are authored `user`; block `i` gets the UUIDv5 of the proposal id and `block:<i>`
  (`proposalBlockId`), so a repeated write collides instead of duplicating. `afterHeading` resolves to the section end
  inside the document mutation; a missing heading is 409.
- Confirm results set `followUp` (`transcriptionQueued`, `mcpSyncQueued`) only after the real enqueue succeeded in the
  same transaction; otherwise `null`.
- An exact-match existing company (IČO) or person (normalized email in `person_email_index`, live only) replaces the
  create with a step that writes nothing to the existing item (primary `update` or nested `link`). No fuzzy matching.

### Computation and grounding

- The model sees bounded ids and names; workspace context is read as the Semprec project through the per-database
  grants. The target catalog (`buildTargetCatalog`) carries select options always, and up to 20 short text values of
  the first five text properties only when the Semprec project may read the target database; delimiters are escaped.
- A computed recognition stays bound to the selected type, processing method and target database; the post-model
  transaction reserves those rows `FOR SHARE NOWAIT` and writes `needsClarification` on drift, never promoting another
  candidate.
- `computing` means the user requested recomputation; it is set with the tick enqueue in one transaction and is the
  only status that bypasses the fingerprint gate. Type change locks source `FOR UPDATE`, type `FOR SHARE NOWAIT`, cards
  `FOR UPDATE NOWAIT` (busy is 409).

### Undo, reopen, locked states

- `confirmed` and `rejected` are locked (`LOCKED_PROPOSAL_STATUSES`). `reopenProposalWithClient`
  (`POST /api/proposals/:id/reopen`, `inbox/proposalReopen.ts`) is the only exit.
- Reopening a confirmed card (`undoConfirmedProposal.ts`) reverses only what confirm recorded: created items
  soft-deleted, patched values restored, recorded edges reversed (`writtenRelations`, `removedRelations` written by
  `writeRecordedEdge`), derived blocks removed, stored MCP credentials deleted, queued follow-ups cancelled. Every
  touched item must still have its recorded `version`, else 409 `version_conflict`. Files moved from an attachment
  stay and are named. No time limit. Any new confirm step defines its recorded data and reversal.
- Reopening a rejected card recomputes nothing: the stored envelope is revalidated and the card becomes `proposed` or
  `invalid`.

### Card locks and invalidation

- Item hooks invalidate/restore open cards referencing an archived or deleted item via `referencedItemIds` with
  `FOR UPDATE SKIP LOCKED`, never waiting for a card another transaction holds; the confirming transaction's own card is
  skipped via `runWhileConfirmingCard`. Every writer of `proposal` stores `referencedItemIds`.
- Source split order: card `FOR UPDATE`, source Inbox item `FOR UPDATE`, card's `sourceInbox` edge `FOR SHARE`. Writers
  holding the source reserve cards `NOWAIT`.
- Card actions honour `Idempotency-Key` through `runIdempotent` (`inbox/idempotentResponsesStore.ts`): advisory lock
  per (tenant, user, key, route), stored first response <400 replayed for 24 hours, different request hash is 400.

### Cross-domain proposal rules

- MCP server cards never grant tools (see MCP grants); connection credentials are stored at confirm.
- Retiring an outdated Semp mail draft (`retireSupersededSempDrafts`) runs the discard steps as `SYSTEM_WRITER` and
  only for drafts whose `created_by` and `last_edited_by` are `agent`; see
  [domain-mail-and-inbox.md](domain-mail-and-inbox.md).
- `page.convertToBlock` requires `confirmedPageCount` equal to the current subtree count (409
  `page_count_mismatch`), locks parent, page, then subpages level by level in id order, and for agents is a
  destructive approval whose approved block is authored `user`. Approved `page.replace`/`page.restoreVersion` are
  authored `user`. Page ETags are `base64url(sha256(Y.encodeSnapshot(...)))` and identify a document state, not visible
  content.

## AI gateway

### Monopoly

- Only `semprec-ai-gateway` (`backend/services/semprec-ai-gateway`, logic in `backend/packages/ai-gateway`) talks to
  model providers or holds their keys. Callers use `backend/packages/ai-gateway-client` or, for agents, the pi
  `pi-messages` API pointed at the gateway (`backend/services/semprec-agents/src/modelComposition.ts`). A provider SDK
  import, key or HTTP call elsewhere is a critical finding; a new provider or model is an adapter behind the gateway.
- Every call carries an operation/purpose and its attribution (`agentRunId`, `sempMessageId`, `projectItemId`);
  attribution the caller's tenant cannot see is `attribution_refused`.

### Budgets and accounting

- One `ai_gateway_calls` row per call: `reserved` at the caller's estimate → `settled` at real cost, or `failed` at 0.
  Transitions are conditional on `status = 'reserved'`. Budget sums count every row at its `cost_usd`. A failed settle
  leaves the row `reserved` at its estimate.
- `reserve` (`backend/packages/ai-gateway/src/gateway.ts`) takes `pg_advisory_xact_lock(hashtext('ai_gateway_budget'))`
  (one global key; anything that reads spend to insert a reservation takes it), checks tenant activity, the tenant's
  `tenant_ai_budgets` caps (tenant timezone; no row refuses, fail closed; `NULL` cap means none) and the operator caps
  `AI_GLOBAL_DAILY_CAP_USD`/`AI_GLOBAL_MONTHLY_CAP_USD` (UTC, via `ai_global_spend()`), then inserts. The lock is
  released at commit, before the provider call.
- Every refusal is the same `BudgetExceededError` ("AI budget exceeded", 403); the cause is logged at `warn` without
  amounts. After rollback, a tenant-caused refusal is announced once per tenant and window
  (`tenantRefusalAnnouncement.ts`): a `sempStatus` invalidation and an `aiBudgetReset` job at `resetsAt`. Operator-cap
  refusals announce nothing.
- Budget problems are derived at read time in `readSempStatusReport` (`aiBudgetMissing`, `aiBudgetExhausted:<resetsAt>`),
  never stored. `getAiUsageReport` computes all call aggregates in one SQL statement (one snapshot).

### Request handling

- Each route derives an `AbortSignal` from `res` (`close` without `writableFinished`, plus a `res.destroyed` check)
  and passes it to the provider; a disconnect is checked first in the error path, logged at `info`, and writes no
  response. The reservation follows the ordinary fail transition.
- `POST /internal/complete` rejects bodies over 8 MiB with a fixed 413 and `Connection: close`, then discards at most
  2 MiB or 2 s before destroying the socket; no reservation or provider call happens.
- A streaming speech-to-text stream keeps its open-registry entry and concurrency slot until its frame-queue tail
  (reservations, late fails, settlements, retries) settles; `closeAll()` resolves only then, so the pool never ends
  under accounting.
- Speech-to-text is reserved in 30-second chunks; text-to-speech capacity refusal is HTTP 503 `tts_capacity_exhausted`
  (`SpeechSynthesisCapacityError` in the client). Voice rows attribute to the Semp assistant message of the turn (TTS
  via `x-semprec-agent-run-id`/`x-semprec-semp-message-id` headers, STT via an `attribute` stream message).
- Agent images are resized ephemerally (`backend/services/semprec-agents/src/refImage.ts`: ≤16 MiB source, ≤32 Mpx,
  ≤1600 px JPEG ≤256 KiB); at `onPayload` the exact JSON body must stay below 4 MiB, oldest images become placeholders
  first, else the call is refused before network. Only refs persist. Agent query tool schemas use local definitions.

### Process lifecycle

- Gateway shutdown (`backend/services/semprec-ai-gateway/src/shutdown.ts`): stop accepting, poll
  `closeIdleConnections` until drained or 60 s, `closeAllConnections` on timeout, close streams, stop the process
  heartbeat, `pool.end()` bounded to 5 s. Idempotent, never rejects, signals registered with `on`.
- API shutdown: close the sync server and voice channel first (close 1012), then HTTP drain, then queue runtime stop,
  then `pool.end()`. Any new long-lived upgraded protocol is closed before the HTTP drain.
- `semprec-agents` assumes one owning instance per database with its predecessor quiesced before startup repair
  (`TimeoutStopSec=120` in `deploy/systemd/semprec-agents.service`; Semp turn grace 90 s, 30 s cleanup margin). Startup
  never force-unlocks graphile-worker locks or infers worker death; a dead chat owner holds its lane until Graphile's
  own expiry.

## Agent runtime and Semp chat

- Agent runs (`agent_runs`, `agent_run_events`) are driven by `backend/packages/agent-runtime` and composed in
  `backend/services/semprec-agents`. Semp thread turns run on a per-tenant chat lane (`sempMessageTask.ts`).
- Failure close of a driven run (`runAgentSessionForRun`, `SempConversation.failRun`): one transaction locks the run,
  confirms it is running, pairs dangling tool uses with synthetic results, closes with
  `finishAgentRunWithErrorNotification` and appends the terminal status; the original error is rethrown (with an
  `AggregateError` if recovery also failed).
- Run watching (`createAgentRunWatchRegistry`, `backend/packages/realtime/src/agentRunWatch.ts`): authorize, register a
  replaying watcher, replay durable `agent_run_events` after the cursor, drain received ids, then go live. Durable
  events travel as thin `{ agentRunId, eventId }` references on `semprec_events`; `message_update` deltas only on
  `semprec_agent_stream`, never persisted. Voice uses a callback subscription on the same owner.
- Message order: all Semp message inserters use one allocator that reserves the thread row and picks
  `max(clock_timestamp(), latest + 1µs)` (`semp/sempMessageOrder.ts`). A cached session is reused only when the thread's
  latest stored message is the reply it completed; otherwise the history is reconstructed.
- Wakes replay complete history within 2000 event rows, 2000 entries and 256 KiB payload; overflow fails the turn
  before the provider call, never truncating.
- Refs on Semp messages are validated against observed tenant state in the send transaction (≤20, no new locks) and
  confer no access; expansion and history labels read through `readSempRefContext` under the turn's tenant scope.
- A rejected tick approval outcome continues with a tool-less acknowledgement turn; the outcome excerpt is untrusted
  data capped at 32 KiB.
- Heartbeat agent runs receive composition-root dependencies (gateway client, run project resolvers) as an argument;
  a config needing a missing dependency is refused. The answer-expected gate brackets its gateway call between read
  transactions; `expectsReply: false`, invalid answers and budget refusals start nothing silently.
- Project guidance: revisions are allocated through `projectAgentGuidanceVersionStore` (lock the receipt row first,
  then guidance; strictly increasing millisecond tokens that survive delete/recreate). `agent_guidance_drift_resolved`
  notifications are deduplicated in a writer savepoint and register a realtime callback only in a managed transaction.
- `withSavepoint` (`backend/packages/data/src/db/pool.ts`) discards the after-commit callbacks, keyed callbacks and
  search jobs queued inside a failed step; any new transaction-level queue must be restored by it.
- `raiseProblem` validates a project reference against the tenant's Projects database inside its conditional insert.

## Voice and speech

- One authenticated WebSocket to `semprec-api` (`backend/services/semprec-api/src/voiceChannel.ts`), one voice-owning
  API process, one session per user. Binary frames `0x01` mic PCM 16 kHz / `0x02` speech PCM 24 kHz; text frames
  `start`, `stop`, `end` / `ready`, `transcript`, `speaking`, `error`, `end`; 16 KiB binary and 4 KiB text limits,
  30 min session, 60 s idle. Transport oversize closes with 1009 without an application frame. Audio is never stored
  or logged.
- Admission is held until the active handler callback settles and cleanup succeeds; callbacks never overlap; a
  deadline is never treated as settlement.
- Final transcripts become ordinary thread messages. Barge-in (first STT partial while speaking) stops speech only.
  A stop command (`stop`, `zruš`, exact after normalization; never stored) cancels running turns through a
  `semp_turn_cancel` notification keyed by tenant and assistant message, aborted by the owning process
  (`InFlightAgentRuns`); best effort, never replayed.
- Voice delivery is correlated per assistant message (`sempMessageId` on deltas, scoped event reads with the message's
  event interval in one statement) and ordered by durable anchor (`afterEventId`, `deltaSequence`,
  `backend/packages/realtime/src/voiceRunDeltaBuffer.ts`); gaps fall back to durable text. Pending speech is bounded per
  request (≤4000 UTF-16 units per sentence/request, ≤32 queued); streamed prefixes are deduplicated by SHA-256 and
  length.
- Dictation runs on the device; the backend has no dictation path. Read-aloud
  (`backend/services/semprec-api/src/sempSpeechHandler.ts`, `semp/messageSpeechStore.ts`) caches audio per message and
  voice; voices are the pinned list `alloy` (default), `ash`, `ballad`, `coral`, `echo`, `fable`, `nova`, `onyx`,
  `sage`, `shimmer`, `verse`. A fill is single-flighted by a session advisory lock held outside transactions on a
  bounded guard connection; provider and storage I/O happen outside transactions and the final transaction rechecks
  the source text. Exactly-once synthesis across session loss is not claimed. One absolute 5-minute deadline bounds
  admission and new phases, never already-issued database work. Budget refusal answers 403 `budget_exceeded`.
- Text-to-speech is provisionally OpenAI `gpt-4o-mini-tts`; the Czech listening comparison is a pre-production
  release condition.
