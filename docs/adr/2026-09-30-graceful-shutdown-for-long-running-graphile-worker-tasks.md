---
status: accepted
date: 2026-09-30
area: [backend]
supersedes: []
superseded-by: null
---

# Graceful shutdown for long-running graphile-worker tasks

## Context

`transcriptionTask`'s steps run one file's ASR pipeline through several
checkpointed stages, and one chunk of the ASR step alone can take minutes
(ffmpeg extraction plus a gateway call). Deploys and restarts stop the
`semprec-transcribe` worker via `Runner.stop()`, which graphile-worker gives
a fixed window to finish before the process is killed. The systemd unit's
default `TimeoutStopSec` (90s) is shorter than that window, so a deploy
landing mid-chunk previously left systemd to SIGKILL the process outright:
the in-flight job's transaction rolled back, and on restart graphile-worker's
built-in retry re-ran the job from scratch, burning one of its three retry
attempts and repeating whatever paid gateway calls the interrupted attempt
had already made before the checkpoint that would have recorded them.

Alternatives considered:

- **Do nothing, rely on retries.** graphile-worker retries a killed job
  automatically, but each SIGKILL both burns a retry attempt (of only three)
  and repeats any non-idempotent work performed since the last checkpoint;
  a deploy cadence that kills a job on every attempt exhausts the retry
  budget without the job ever finishing.
- **Catch `Runner.stop()` and let the job fail cleanly (no re-enqueue).**
  Fails fast without wasting the remaining stop window, but still spends a
  retry attempt for a shutdown that was never the task's fault, and still
  needs graphile-worker's retry backoff to elapse before resuming — slower
  than an immediate re-enqueue for a condition that isn't an error.
- **Longer `TimeoutStopSec` alone, no code changes.** Reduces how often the
  timeout is hit but does not eliminate the failure mode: any task whose
  single checkpoint interval can exceed the configured timeout (a stalled
  gateway call, a larger file) still gets SIGKILLed with the same
  consequences.

## Decision

A long-running task that wants graceful shutdown does the following:

1. **Detect `Runner.stop()` via `helpers.abortSignal`.** graphile-worker
   sets this `AbortSignal` when `Runner.stop()` begins; the task reads
   `helpers.abortSignal?.aborted` rather than listening for a signal itself.
2. **Poll it only between atomic checkpoints, never mid-write.** A helper
   (`throwIfShutdownRequested` for this task) is called at step boundaries
   and, for a step that itself loops over chunks, between chunk iterations —
   always at a point where the previous unit of work has already committed
   and the next one has not yet started. It is never checked inside a
   transaction or mid-write, so an interruption never leaves a checkpoint
   half-written.
3. **On interruption, re-enqueue by key and return normally — don't throw
   through to the retry path.** The step throws a dedicated error
   (`TranscriptionInterruptedError`) that the task's outer handler catches
   specifically; the handler re-enqueues a fresh job for the same key (here,
   `fileItemId`) and returns without rethrowing, so graphile-worker records
   the attempt as a normal success and spends none of the job's retry
   budget. The re-enqueued job resumes from whatever checkpoints the
   interrupted attempt already wrote.
4. **Size `TimeoutStopSec` (or the equivalent `gracefulShutdownAbortTimeout`
   for an in-process runner) to the slowest single interval between two
   checkpoints, not to the whole job.** For `semprec-transcribe` this is one
   ASR chunk's worst case — ffmpeg extraction plus the gateway call plus the
   checkpoint write — set at 960s in `deploy/systemd/semprec-transcribe.service`.
   Sizing it any tighter risks the SIGKILL this pattern exists to avoid;
   sizing it to the whole job wastes shutdown time waiting out chunks that
   would have checkpointed long before the deadline anyway.

## Consequences

- A deploy or restart during `semprec-transcribe` no longer costs a retry
  attempt or repeats paid gateway work already checkpointed; the worst case
  is resuming from the last checkpoint instead of the last successful chunk.
- This pattern requires the task to already be checkpoint-resumable —
  `throwIfShutdownRequested` is safe to call between checkpoints only
  because each checkpoint's own transaction is the unit of progress a
  re-enqueued job picks up from. A task without checkpoints (nothing to
  resume from) or one that must run atomically end-to-end (nothing safe to
  interrupt between) should not adopt this pattern; catching `Runner.stop()`
  for a non-resumable task just delays the eventual SIGKILL rather than
  removing its cost.
- This decision is not applied automatically to other long-running
  graphile-worker tasks (mail sync, agent runs). Each should evaluate this
  ADR against whether it has (or can be given) checkpoint-based resumability
  before adopting the pattern; none is changed by this decision.
