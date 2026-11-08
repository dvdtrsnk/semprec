---
status: accepted
date: 2026-11-06
area: [backend]
supersedes: []
superseded-by: null
---

# Semp wakes replay complete bounded history and fail closed on overflow

## Context

Gh1727 requires a fresh session to reconstruct stored history. The default SempConversation reconstruction returns null and would silently lose earlier turns if used in production. The old CompactionAdapter is a historical structural seam; its existence does not supply production compaction.

Pinned pi-agent-core 0.85.1 now exports estimateContextTokens, shouldCompact, prepareCompaction and compact at its public root, so the old comment claiming all these names are unpublished is obsolete. Their current native entry/result and request types differ from the historical adapter. GatewayModel also reports an unknown contextWindow of zero. Neither an always-no-compaction adapter nor pretending an arbitrary number is that model's token window would be a valid integration.

## Decision

Compose one explicit bounded complete-history reconstruction for queued Semp turns, using the real existing event owner and protocol parser. The fixed local replay policy is at most 2000 stored event rows, at most 2000 expanded conversation entries, and at most 262144 UTF-8 bytes of serialized payload data. These are application resource limits, not a claim that any provider's model context will fit. The gateway retains its own request/model admission.

The existing data reader may accept optional bounds for this caller. Determine overflow using one consistent SQL statement snapshot before returning unbounded payloads; inspecting at most limit+1 event metadata rows detects row overflow. Measure payload bytes in the database and withhold payload transfer when over budget, including one oversized compaction checkpoint. Preserve the exact latest-checkpoint selection and wake/event ordering. No partial prefix/tail is returned as a complete history, and no SQL rows are deleted.

Reuse the existing stored message/checkpoint validation and tool-call pairing checks. After bounded expansion, verify entry and byte limits again before the model is called. Null means genuinely no prior entries, never overflow or failure. Every fitting history is replayed in full, including its stored user text and tool results. An oversized or invalid history fails the turn through its existing error lifecycle before the provider call; leave durable history/checkpoints unchanged and log no conversation content. No new stored error-code taxonomy is introduced before gh1907.

A single narrowly exported bounded factory can be composed by semprec-agents for gh1727. Existing compaction-enabled callers and the old default for unrelated callers remain unchanged. Do not manufacture an adapter with shouldCompact always false, invoke private pi imports, add a direct provider call or silently truncate to satisfy the limit. This batch does not deliver automatic model compaction; a future production compaction integration must preserve [[2026-09-10-ai-gateway-monopoly-on-provider-calls]] and exact request attribution. The model-only current-turn date prefix never rewrites replay entries.

## Evidence

Prove real stored multi-wake reconstruction through the queued turn/session composition, tool-use/result pairing, latest checkpoint plus tail, tenant isolation and original-text preservation. Cover exact-boundary and over-boundary counts/bytes, a single oversized checkpoint, and refusal before a provider call with unchanged durable history. A fake provider transport may be used; an empty reconstruction stub or synthetic compaction success is not production evidence.
