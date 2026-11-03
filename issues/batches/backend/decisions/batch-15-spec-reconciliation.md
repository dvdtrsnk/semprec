# Batch 15 specification reconciliation

Authority: owner-delegated controller supervision under the backend program.

## 1. MCP model-name suffixes (gh-1533)

Retain the exact Task algorithm: sanitized/shortened tool name plus the first eight lowercase hexadecimal characters of the immutable server id. Two distinct UUIDs can share this prefix, so a universal distinct-suffix claim is impossible. The AC now requires different suffixes only for different eight-character prefixes and explicitly retains the existing final collision warning and later-tool drop for equal final names. Task 2 names this residual cross-server collision as well as within-server sanitization/truncation collisions. This is a correction to the internally inconsistent specification, not a new naming protocol or a guarantee of globally unique 32-bit prefixes. Generic tools, labels, histories, authorization and registration identity remain governed by their existing contracts.

Only the existing gh-1533 production/test Touches apply. Prove differing prefixes and the real collision safeguard for equal prefixes in the approved test harness. No extra review round is authorized.

## 2. Structured result outcomes (gh-1527)

An approval-deferred generic or MCP call is distinct from an ordinary failed execution. Preserve its existing error flag and model text, record approvalRequestId, and omit changes. Ordinary failures omit both structured fields; successful non-patch calls have no changes or approval id. For a successful patch lacking a reported previous value, retain the change key and omit only before, following Task 5 and its specific AC rather than the contradictory Context sentence. LongText entries still contain the key alone. This does not permit a speculative pre-image read or change approval execution. Existing production and test Touches suffice.

## 3. Actual next-wake evidence (gh-1568)

Authorize the existing agent-runtime sempConversation.test.ts harness solely for the explicit actual next-wake clauses: an idle session repaired after restart and a mid-tool failed or cancelled turn must allow the next SempConversation.send. Use the real conversation/reconstruction and persisted history with fake sessions, retaining existing tenant scope and failure notification semantics. Helper-only history validation is insufficient for the claimed send boundary. No SempConversation production lifecycle expansion, unrelated fixture cleanup or new review round is authorized.
