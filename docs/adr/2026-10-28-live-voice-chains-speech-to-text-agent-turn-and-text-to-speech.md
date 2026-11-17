---
status: accepted
date: 2026-10-28
area: [backend, mobile]
supersedes: []
superseded-by: null
---

# Live voice chains speech-to-text, an agent turn and text-to-speech

## Context

Semp should have a live voice mode: the user speaks, sees their words appear and
hears Semp answer, inside a Semp thread. Today the backend only transcribes
recordings in batch: `semprec-transcribe` calls the gateway routes
`/internal/transcribe` (Whisper) and `/internal/diarize` (pyannote). There is no
streaming speech-to-text and no text-to-speech. The realtime protocol has no
audio frames; its binary frames are Yjs documents with a 16-byte prefix.

Constraints that already exist and that this decision builds on:

- Only the gateway talks to providers and holds their keys
  ([[2026-09-10-ai-gateway-monopoly-on-provider-calls]]), and the host enforces
  that by filtering egress per service uid
  ([[2026-10-03-host-egress-filtered-by-service-uid]]).
- Budgets are per tenant with a global safety cap, reserved under one advisory
  lock before the provider call
  ([[2026-10-16-per-tenant-ai-budgets-with-a-global-safety-cap]], which
  supersedes [[2026-09-27-ai-budget-reservations-under-a-global-advisory-lock]]
  and keeps its reserve/settle/fail lifecycle). Audio calls are recorded in
  `ai_gateway_calls` with `audio_seconds` and today never carry an agent run id.
- A client that cannot keep up is closed, not buffered
  ([[2026-09-16-realtime-outage-and-backpressure-close-rather-than-buffer]]).
- A gateway call that loses its client is aborted
  ([[2026-09-28-client-disconnect-propagation-in-the-ai-gateway]]).

This ADR fixes the design that #1396 (streaming speech-to-text), #1399
(streaming text-to-speech) and #1546 (the authenticated voice channel) implement
and #1734 joins to Semp threads. Dictation into the message field is not part of
it: it uses the device's own speech recognition (#1372).

## Decision

### 1. Pipeline: speech-to-text, a normal agent turn, text-to-speech

The voice channel produces final transcripts, each final transcript is submitted
to the Semp thread as an ordinary user message, the agent turn runs through the
thread queue unchanged, and the turn's reply text is synthesized to speech.

- Alternative rejected: a speech-to-speech (realtime) model. It would bypass the
  thread queue, tools, approvals and step history, would need its own tool and
  approval bridge, and would put a second conversation state beside the thread.
- Trade-off accepted: latency is the sum of three stages, and Semp's voice is
  only as expressive as the synthesis of finished sentences. Text-to-speech
  starts per sentence as the reply streams, which bounds the added delay to the
  first sentence.
- Every provider call stays in the gateway; the voice channel adds adapters, not
  a side channel.

### 2. Providers

Czech is the primary language; English is secondary.

- **Streaming speech-to-text:** OpenAI streaming transcription
  (`gpt-4o-transcribe` through the realtime transcription interface), as a
  gateway adapter. Chosen by Czech quality (the same model family as the Whisper
  adapter already used for batch Czech), native streaming with interim and final
  results, and one vendor shared with text-to-speech. Rejected: Deepgram
  streaming (lower latency, but weaker Czech for conversational speech and one
  more vendor and credential); Google Cloud Speech streaming (adds a cloud
  account and credential model for no Czech advantage); streaming by re-sending
  buffers to the batch Whisper route (no interim results, and cost and latency
  grow with utterance length).
- **Text-to-speech:** OpenAI TTS (`gpt-4o-mini-tts`), as a gateway adapter, with
  ElevenLabs the rejected alternative.
  - Listening test: the same ten Czech passages (greetings, numbers and dates,
    names with diacritics, a long sentence, a question, an English loan word)
    are synthesized by both providers and rated blind by two Czech speakers on
    pronunciation, prosody and naturalness, plus first-audio latency.
  - **Status of the test:** the author of this ADR could not perform a listening
    test, so the choice above is provisional and no result is recorded. #1399
    must run the test above before its adapter ships. If ElevenLabs wins, a new
    ADR supersedes this section's provider choice; the contract below does not
    change, because the adapter sits behind the gateway contract. OpenAI is the
    default because it is one vendor, one credential and one billing line with
    speech-to-text.
- Dictation is out of this pipeline (#1372).

### 3. Transport: one authenticated WebSocket to `semprec-api`

The client opens a WebSocket to `semprec-api`; the tenant and user come from the
session at upgrade, as for the realtime socket. The API forwards audio to the
gateway over its internal, token-protected routes and relays results back. The
client never reaches the gateway or a provider.

- Alternative rejected: audio frames on the existing realtime socket. Its binary
  frames are Yjs documents and its backpressure policy is tuned for thin
  invalidations; mixing latency-sensitive audio into it couples two failure
  modes.
- Alternative rejected: a provider-issued client token (direct to provider). It
  breaks the monopoly and bypasses budget reservation.

**Frames.** Binary frames carry audio only, with a one-byte type prefix:

| Byte   | Direction        | Payload          |
| ------ | ---------------- | ---------------- |
| `0x01` | client to server | microphone audio |
| `0x02` | server to client | speech audio     |

Microphone audio is raw PCM, signed 16-bit little-endian, mono, 16000 Hz, in
frames of 20 ms to 100 ms of audio. Speech audio is raw PCM, signed 16-bit
little-endian, mono, 24000 Hz, in frames of at most 100 ms. Raw PCM is chosen
over Opus because every platform captures and plays it with no codec dependency,
and [[2026-09-22-ffmpeg-confined-to-semprec-transcribe]] keeps ffmpeg out of the
API. The cost is bandwidth (about 32 KB/s up, 48 KB/s down), accepted for a
foreground interactive mode.

Text frames are JSON objects with a `type` field. Client to server: `start`
(language, optional thread id), `stop` (explicit stop command, see 6) and `end`
(close the session). Server to client: `ready`, `transcript` (`text`,
`final: boolean`), `speaking` (`state: started|stopped`), `error` (a stable
`code` such as `budgetExceeded`, `sessionLimit`, `idleTimeout` or `overloaded`,
and no provider text) and `end`.

**Per-session limits.**

| Limit                                        | Value                                      |
| -------------------------------------------- | ------------------------------------------ |
| Maximum frame size                           | 16 KiB for binary frames, 4 KiB for text   |
| Maximum session duration                     | 30 minutes                                 |
| Idle timeout (no audio and no control frame) | 60 seconds                                 |
| Concurrent voice sessions                    | 1 per user                                 |

An oversized, malformed or unknown frame closes the socket with an `error`
frame. Every limit closes the session with its own error code.

### 4. Budget: fixed chunks, one row per chunk

Audio of unknown length is reserved in fixed chunks of **30 seconds**. Before
the first audio and then before each further chunk is consumed, the gateway
reserves one chunk through the existing reserve step (same advisory lock, same
tenant and global caps) as one `ai_gateway_calls` row, and settles the row with
the real `audio_seconds` when the chunk ends or the stream does. A refusal ends
the stream with the `budgetExceeded` error; the identical-message rule of
[[2026-10-16-per-tenant-ai-budgets-with-a-global-safety-cap]] is unchanged.
Speech-to-text and text-to-speech each reserve their own chunks. For
text-to-speech the reserved amount is an estimate of the synthesized seconds
from text length, settled to the real seconds.

- Alternative rejected: reserve one call for the whole session. The cap could
  not stop a long session in time and one row would hide the usage pattern.
- Alternative rejected: reserve the 30 minute maximum up front. It would block
  other calls of a small tenant for the whole session.
- Trade-off accepted: one advisory-lock transaction per chunk, so a stream takes
  at most two per minute per direction; an overshoot is bounded by one chunk.

**Attribution.** Voice rows carry the Semp thread, the turn and the agent run
they serve, in the same way as the other gateway calls of a turn.
Speech-to-text of an utterance that has not yet produced a turn carries the
thread and no run, and the run is attached once the turn exists. Rows use the
purpose `voice` and appear as their own Voice activity in AI usage reports. They
count against the tenant's budget like every other row.

### 5. Audio is never stored

Neither microphone audio nor synthesized audio is written to disk, the database,
object storage or logs, in the API or the gateway; it exists only in memory
buffers for the life of the frame. Only transcripts, which are ordinary thread
messages, and `ai_gateway_calls` metadata (including `audio_seconds`) persist.
Alternative rejected: storing audio for replay or debugging, which would add a
retention and privacy surface for no feature in scope. Trade-off: voice problems
cannot be replayed from recorded audio, only from frame counts and error codes.

### 6. Interruption and stop commands

- User speech while Semp speaks stops the speech output only: the API stops
  forwarding speech audio, cancels the in-flight text-to-speech request, and
  sends `speaking: stopped`. It does not cancel the agent turn. The new
  utterance becomes a normal message and its turn waits in the thread's queue.
- Voice cancels a running agent turn only on an explicit stop command: the
  `stop` control frame, or a final transcript that is exactly "Stop" or "Zruš"
  (case-insensitive, punctuation trimmed). It is an ordinary cancellation of the
  turn, through the same path as the cancel button.
- A write that is waiting for approval is never executed without the approval;
  cancelling the turn leaves it unapproved, and voice has no spoken approval.
- Alternative rejected: barge-in cancels the turn. A cough or a side
  conversation would destroy a long-running turn and its partly completed steps.
  Trade-off: a user who changes their mind must say the stop command.

### 7. Backpressure: close, not buffer

The voice channel follows
[[2026-09-16-realtime-outage-and-backpressure-close-rather-than-buffer]]. If the
socket's outgoing buffer exceeds 256 KiB (about 5 seconds of speech audio) or
the gateway stream cannot accept microphone frames, the session is closed with
the `overloaded` error. Audio is not dropped silently, queued, or resampled
under load; the client reconnects and starts a new session. Alternative
rejected: dropping the oldest audio, which makes transcripts silently wrong.
Trade-off: a congested network ends the session instead of degrading it.

## Consequences

- The three implementation issues build against fixed numbers: 30 s chunks,
  16 kHz and 24 kHz PCM, the limits table and the error codes. Changing one
  later is a new ADR.
- The gateway gains streaming speech-to-text and text-to-speech adapters, and
  voice rows in `ai_gateway_calls` must be able to carry a run id, which audio
  rows could not before.
- The text-to-speech provider choice is provisional until the Czech listening
  test is run; this is the one open item of this decision.
- Budget reservation for voice takes the global advisory lock more often than
  batch calls, bounded by the one-session-per-user limit.
