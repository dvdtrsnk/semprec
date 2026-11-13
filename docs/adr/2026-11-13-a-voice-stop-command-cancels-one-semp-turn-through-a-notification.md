---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# A voice stop command cancels one Semp turn through a notification

## Context

[[2026-10-28-live-voice-chains-speech-to-text-agent-turn-and-text-to-speech]] decided that voice cancels a running
agent turn only on an explicit stop command, as an ordinary cancellation, and that cancelling never decides an approval
request. The turn runs in `semprec-agents` and the voice session in `semprec-api`; the only abort that process
had was per tenant, driven by [[2026-10-17-tenant-deactivation-tears-down-in-process-state]]. Cancelling one turn
needs a signal between the two processes, and someone has to own the `AbortController` it ends.

## Decision

1. **Recognition.** `isVoiceStopCommand` (`semprec-api/src/voiceStopCommand.ts`) is true for a final transcript that,
   after Unicode normalization (NFC), trimming, lower-casing and removing trailing punctuation and whitespace, equals
   exactly one entry of the closed list `VOICE_STOP_COMMANDS = ["stop", "zruš"]`. Anything else, a longer sentence
   containing a word of the list included, is an ordinary message. A stop command is never stored as a message.
2. **The signal.** A Postgres notification on `semp_turn_cancel` (`SEMP_TURN_CANCEL_CHANNEL`,
   `packages/data/src/semp/sempTurnCancellation.ts`). The payload is the JSON text
   `{"tenantId":"<uuid>","assistantMessageId":"<uuid>"}`, built by Postgres with `json_build_object` and uuid
   casts; a listener accepts exactly those two keys with uuid values and logs the channel only and drops anything
   else. `requestSempTurnCancel` runs on the caller's client: outside a transaction the notification is delivered at
   once, inside one when it commits.
3. **The tenant is part of the key.** The sender states the tenant of its own authenticated session. The receiver
   finds a turn only under the pair (tenant, assistant message), so the id of a message of another tenant, or a
   random id, matches nothing and is ignored. The listener reads no tenant data.
4. **Who aborts.** The process that runs the turn owns the controller of its job. `withInFlightRegistration`
   registers that same controller per tenant and, for a Semp message job, under the assistant message it answers
   (`InFlightAgentRuns.registerTurn`); `abortTurn(tenantId, assistantMessageId)` aborts it without a reason, so the
   turn handler stores the reply as `error` with `error_code` `cancelled`, the run is closed with `cancelled`, and the
   dangling tool calls are paired, exactly as for an abort by tenant deactivation. Only the `shutdown` reason is an
   interruption. The voice session writes nothing about the turn.
5. **Which turns.** The session looks up the assistant messages of its thread whose status is `running`
   (`listRunningSempTurnIds`) and requests the cancellation of each, in one transaction with the lookup. A reply that
   is still `queued` has no turn to abort; with no thread, or no running turn, the command does nothing but stop the
   speech output.
6. **Best effort, no resynchronization.** A notification is not stored. One sent while the receiving process is
   reconnecting its `LISTEN` connection, or after the turn ended, is lost, and the person says the command again.
   Unlike the tenant status signal, nothing is replayed on reconnect, because a replayed cancellation would abort a
   turn the person did not ask to stop. The listener reconnects with the capped exponential backoff of the tenant
   status listener (200 ms to 5 s) and closes with it at shutdown.
7. **The voice session ends the turn quietly.** A reply that ends as `error` with `error_code` `cancelled` for a
   message this session asked to cancel ends the session's turn without failing the session; every other `error`
   reply still fails it as `unavailable`.

## Consequences

- Cancelling a turn never decides an approval request. A request the turn already created stays `pending`, and its
  write is executed only after the person approves it.
- A stop command that arrives in the short time between the claim of a reply and its first stored run event cancels
  the turn before the voice session has a run to watch. The session still ends that turn quietly, because it knows
  from the command it sent that the cancellation is the answer: it checks the reply before it gives up on a missing
  run, and again when the run watch refuses a reply that was cancelled before the watch started. A reply that fails
  before it has a run for any other reason still fails the session as unavailable.
- Alternative rejected: a stored cancellation request that the agents process polls or resyncs. It would survive a
  reconnect, at the price of a table, a retention rule and the risk of a stale request cancelling a later turn.
- Alternative rejected: an HTTP call from `semprec-api` to `semprec-agents`. The agents process has no HTTP
  intake, and the two processes already share Postgres.
