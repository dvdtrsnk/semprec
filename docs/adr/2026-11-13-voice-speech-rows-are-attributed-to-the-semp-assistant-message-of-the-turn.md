---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# Voice speech rows are attributed to the Semp assistant message of the turn

## Context

[[2026-10-28-live-voice-chains-speech-to-text-agent-turn-and-text-to-speech]] says that voice rows carry the Semp
thread, the turn and the agent run they serve, and that a speech-to-text row without a turn yet is attached to
the run once the turn exists. The other gateway calls of a turn already carry `ai_gateway_calls.agent_run_id` and,
since gh-1744, `ai_gateway_calls.semp_message_id`, the assistant message the call answers; the thread is reached
through that message. The rows of the two voice operations (`voice_transcribe_stream`, `voice_synthesize`) carried
neither, so the per-run and per-reply usage of gh-1822 and gh-1889 never counted speech.

Two things make the speech rows different from a model call. A speech-to-text row is reserved per chunk of an open
stream, before the question it covers has become a message, and a stream outlives many questions. A text-to-speech
row is written by the request that speaks, which knows the turn. This record fixes what each carries and how a
row that was reserved earlier is attributed later. Each point had an alternative.

## Decision

1. **The unit is the assistant message of the turn.** As for every other call of a turn, and without a thread
   column on `ai_gateway_calls`. Text-to-speech of an answer, live or read aloud, carries the message's id and its
   run id. The speech of a spoken question carries the id of the assistant message created for the turn that the
   question started and no run id, because the run does not exist yet when the speech is consumed; the run is
   reached through `semp_messages.agent_run_id`.
2. **Text-to-speech through two optional headers.** `POST /internal/tts/stream` reads `x-semprec-agent-run-id`
   and `x-semprec-semp-message-id` with the validation of `POST /internal/pi/messages` (absent is null, present and
   not a UUID is a 400 naming the header) and writes both on the row when it reserves it, so the settled row
   carries them too. A run or a message that the caller's tenant cannot see is refused as `attribution_refused`
   with no row, like every other attribution of the gateway.
3. **Speech-to-text through an `attribute` control message.** The stream accepts the JSON message
   `{type: "attribute", sempMessageId}`. It sets `semp_message_id` on every chunk row that the same stream reserved
   since it opened or since its previous `attribute` message, whatever their status, in one statement that writes
   only when the message and every one of those rows are visible in the stream's tenant. Rows of another stream
   and another tenant are not named by it and cannot be reached by it. A message the tenant cannot see closes the
   stream with 1008 and no error message, like a refused reservation, and the rows stay as they were; a message
   that is not a UUID closes it as `invalid_frame`. When a chunk is open at that moment, its row is attributed too,
   so a chunk that spans two questions carries the first one's turn: attribution follows the rows, and how a stream
   is cut into rows (gh-1396) does not change.
4. **Speech that never becomes a message is not attributed by the speech itself.** Muted speech, speech that ends
   the session and a stop command send no `attribute` message of their own. Its rows are settled and count against
   the tenant's budget as before, and keep no attribution as long as no later question is attributed on the same
   stream; then they appear only in the tenant's totals. A row reserved in the same attribution window as a later
   question, that is after the previous `attribute` message and before the next, is attributed to that question's
   turn by the next `attribute` message, the same chunk-granularity consequence as in point 3: attribution follows
   the rows, and the gateway cannot tell which speech of a chunk became a message.
5. **The usage of a reply reaches the speech-to-text rows through the message.** `getAgentRunUsage` with a
   message counts a call that carries the run's id, and a call that carries no run id when the message belongs to
   the run. A call that names another run never counts for this one. The usage of a whole run, without a message,
   counts only the calls that carry the run's id; reaching the rows of a message-only call from a run would scan
   `semp_messages` by an unindexed run id, and a decision for it is not part of this record.

## Alternatives rejected

- **Attributing the speech-to-text rows when they are reserved.** The message does not exist then, and the
  reservation must precede the audio it covers.
- **Attributing by time window on the server.** The gateway cannot tell where a question ends; the API knows it,
  because it stores the message.
- **Closing the open chunk at every `attribute` message so that each question has its own rows.** It would change
  how voice budget is reserved and settled, which gh-1396 owns.
- **A thread id column on `ai_gateway_calls`.** The thread is a property of the message.

## Consequences

- A stream that the client ended closes when the provider reports the last final transcript. The `attribute`
  message of that last utterance is sent after the message is stored, so it can reach a closed stream, and then its
  rows stay unattributed.
- The per-reply usage of a spoken turn includes both directions of its speech; the per-run usage of gh-1822 includes
  the text-to-speech rows and not the speech-to-text rows.
