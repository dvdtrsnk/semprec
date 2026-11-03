# Batch 15 specification reconciliation

Authority: owner-delegated controller supervision under the backend program.

## 1. MCP model-name suffixes (gh-1533)

Retain the exact Task algorithm: sanitized/shortened tool name plus the first eight lowercase hexadecimal characters of the immutable server id. Two distinct UUIDs can share this prefix, so a universal distinct-suffix claim is impossible. The AC now requires different suffixes only for different eight-character prefixes and explicitly retains the existing final collision warning and later-tool drop for equal final names. Task 2 names this residual cross-server collision as well as within-server sanitization/truncation collisions. This is a correction to the internally inconsistent specification, not a new naming protocol or a guarantee of globally unique 32-bit prefixes. Generic tools, labels, histories, authorization and registration identity remain governed by their existing contracts.

Only the existing gh-1533 production/test Touches apply. Prove differing prefixes and the real collision safeguard for equal prefixes in the approved test harness. No extra review round is authorized.
