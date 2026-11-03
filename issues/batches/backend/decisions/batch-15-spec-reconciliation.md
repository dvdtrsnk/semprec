# Batch 15 specification reconciliation

Authority: owner-delegated controller supervision under the backend program.

## 1. MCP model-name suffixes (gh-1533)

Retain the exact Task algorithm: sanitized/shortened tool name plus the first eight lowercase hexadecimal characters of the immutable server id. Two distinct UUIDs can share this prefix, so a universal distinct-suffix claim is impossible. The AC now requires different suffixes only for different eight-character prefixes and explicitly retains the existing final collision warning and later-tool drop for equal final names. Task 2 names this residual cross-server collision as well as within-server sanitization/truncation collisions. This is a correction to the internally inconsistent specification, not a new naming protocol or a guarantee of globally unique 32-bit prefixes. Generic tools, labels, histories, authorization and registration identity remain governed by their existing contracts.

Only the existing gh-1533 production/test Touches apply. Prove differing prefixes and the real collision safeguard for equal prefixes in the approved test harness. No extra review round is authorized.

## 2. Structured result outcomes (gh-1527)

An approval-deferred generic or MCP call is distinct from an ordinary failed execution. Preserve its existing error flag and model text, record approvalRequestId, and omit changes. Ordinary failures omit both structured fields; successful non-patch calls have no changes or approval id. For a successful patch lacking a reported previous value, retain the change key and omit only before, following Task 5 and its specific AC rather than the contradictory Context sentence. LongText entries still contain the key alone. This does not permit a speculative pre-image read or change approval execution. Existing production and test Touches suffice.

## 3. Actual next-wake evidence (gh-1568)

Authorize the existing agent-runtime sempConversation.test.ts harness solely for the explicit actual next-wake clauses: an idle session repaired after restart and a mid-tool failed or cancelled turn must allow the next SempConversation.send. Use the real conversation/reconstruction and persisted history with fake sessions, retaining existing tenant scope and failure notification semantics. Helper-only history validation is insufficient for the claimed send boundary. No SempConversation production lifecycle expansion, unrelated fixture cleanup or new review round is authorized.

## 4. Populated additive upgrades (gh-1618, gh-1683, gh-1773)

Authorize the existing data migrationCompatibility.test.ts harness for actual staged runMigrations upgrades over persisted pre-0116, pre-0117 and pre-0122 fixtures. A NULL inserted into a fully migrated schema is not upgrade evidence. Exercise the relevant nullable tool_call_id, description and notification body additions, unchanged legacy fields/readability and old explicit-column writes, plus the applicable partial unique index behavior. Construct historically valid rows at their actual schema boundary; retain original migration bytes and no-backfill semantics. Use the existing owned scratch-database lifecycle with managed transactions and preserved failures. Do not modify unrelated historical fixture behavior or extend default timeouts to hide a failure.

## 5. Persisted production-session composition (gh-1527, gh-1618)

Authorize the existing agents agentRun.e2e.test.ts harness solely to connect the real composed generic and MCP adapters through pi event emission and the agent_run_events writer. Assert each created approval id and execute toolCallId against its actual persisted row/event, and actual successful item.patch changes against the transaction-derived pre-image. Use the existing fake provider and local controlled MCP seam; no live model or server is authorized. Existing adapter/unit tests remain useful segment evidence but do not independently prove the persisted composed path. Run this file under the actual E2E config; a named-file pass is distinct from the complete E2E tier. These additions do not alter production protocols or reset the finite review budget.

## 6. Activity field versus future list (gh-1728), and flag correction

The current backend has no Semp thread-list reader. gh-1728 explicitly excludes that endpoint and assigns it to gh-1729, whose Task introduces lastActivityAt projection and ordering. The final AC is reconciled to the persisted tick thread last_activity_at now; actual list behavior remains deferred, not PASS. Use the real tick-thread creation seam and both current approval producers. Add the existing genericOperationGateway.test.ts and mcpInvokeTool.test.ts test paths solely for producer activity assertions, preserving existing approval and notification behavior. Other no-thread, rollback, delegated and monotonic timestamp requirements remain unchanged.

Correction to the reported premise behind §2: both actual pendingApprovalResult implementations currently return error:false, not error:true. Preserve that flag and text. Approval deferral remains distinct from ordinary failure and successful non-patch execution; its approvalRequestId is required. The earlier worker report and parent handoff claiming true were mistaken and do not authorize changing it.

Repeated upgrade/session Touches descriptions were shortened with explicit references to §§4–5 to keep the aggregate below the issue body cap; paths and limits remain unchanged.
