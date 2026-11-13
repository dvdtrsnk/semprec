---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# Tool call arguments and assistant text after a sensitive read are stored redacted

## Context

[[2026-11-13-sensitive-tool-results-are-marked-by-the-tool-and-stored-redacted]] keeps the content of a sensitive
database out of the stored `tool_result` event. The same values still reach `agent_run_events` as the arguments of a
tool call (a value the agent writes into a health record), as assistant text that quotes what it read, and through a
compaction checkpoint built from the replayed history. Issue #2001 closes those three paths. The product owner decided
that they are redacted in the same way as the source, with the marker `[redacted: sensitive]`, and that the live
session in memory stays unchanged.

## Decision

**A turn is one `runAgentTurn` call.** A call of `runAgentTurn` keeps one flag, "a persisted `tool_result` of this
call carried the sensitive mark", set when it stores such a result. It is not reset by pi's `turn_start` markers (the
final answer of a user prompt comes in a later pi turn than the tool results it quotes), and a later `runAgentTurn`
call on the same run starts without it.

**Stored form once the flag is set.** Every later `tool_use` of the call is stored with the marker as its `arguments`;
the tool name, the call id, the operation and the target ids stay, so every call still pairs with its result. Every
later assistant `message` is stored with the marker as its `text`; each text block of its `content` becomes the marker,
thinking blocks are dropped, and a `toolCall` block keeps its id and name with `{ "redacted": "[redacted: sensitive]" }`
as arguments (pi types a tool call's arguments as an object, and a replay validates that).

**A content-bearing write is redacted from the start.** A `tool_use` of `item.create` or `item.patch` is stored with
the marker as its arguments when its target database, or the database of its target item, is sensitive, whether or not
the turn already has a marked result. The flag is read through the choke point in the caller's tenant scope, as in the
source record. A call that names no target, a target that resolves to nothing, a failed lookup (logged with the
operation, the run and the error class only) and a run handle that is a pool client, from which no choke point can be
built, all count as sensitive.

**The assistant message that precedes such a call is redacted when it is stored.** pi emits the assistant `message`
with its `toolCall` blocks before it starts the calls, so that message is stored before the `tool_use` event of its
calls and, in the first sensitive step of a turn, before any result is marked. The session therefore attaches
`toolCallTargets` to the `message` event: for each `toolCall` block whose tool name maps to a generic operation (the
session's tool-name to operation map), the block's call id, the operation and the `databaseId` and `itemId` of the
block's arguments. The redactor runs the same lookup as for the `tool_use` (content-bearing operation, sensitive target
database, failing closed) on each of them and stores the blocks that qualify with `{ "redacted": "[redacted: sensitive]" }`
as arguments, keeping the block's id and name. `toolCallTargets` steers this decision and is never stored. A block
of a tool that maps to no operation, or to an operation that is not a content-bearing write, is stored as it is, as its
`tool_use` is. The text and thinking blocks of that message are stored as they are: the decision redacts assistant
text only after a marked result, and does not classify text by its content.

**Replay redacts the remaining blocks.** `walkStoredEntries` in `conversationReconstruction.ts` replaces the arguments
of every `toolCall` block whose call id belongs to a `tool_use` stored with the marker, so the arguments of a session that attaches
no `toolCallTargets` never reach a resumed session or a compaction. A compaction is always computed from this reconstructed history, never from the live session.

**The run row keeps the stored form of the last message.** `agent_runs.result` is read back into the context of other
agents (the heartbeat run list, the automation prompt), so it is persisted assistant text like the event. The paths
that write it (`runAgentSessionForRun`, the queued `agentRun` job and the heartbeat `runAgent`) take the last message
from `runAgentTurnWithStoredForm`, which returns it next to the live one in the form written to `agent_run_events`:
after a marked result the result of the run is the marker. `runAgentTurn` and `onEvent` still hand out the live
message, and the replies that `SempConversation` and `DelegationRegistry` return to their callers are live replies,
not stored state.

## Consequences

The text and thinking of the assistant message that carries a sensitive write call stay in full when no result is
marked yet, as the decision allows; the arguments of its `toolCall` blocks do not. The live reply is still returned
unredacted to a caller of `runAgentTurn`, and a delegating agent receives the delegate's live reply as the result of its
delegation tool call, which is stored as that tool result (a result the sensitive mark of the source record does not
cover). Tool calls issued in parallel with a call whose result is marked are stored before the mark exists. Events and
run results stored before this change are not rewritten. A new content-bearing write operation must be added to the
list in `sensitiveTurnRedaction.ts`, or its arguments are stored in full until its result is marked.
