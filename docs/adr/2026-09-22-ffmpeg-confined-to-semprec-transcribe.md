---
status: accepted
date: 2026-09-22
area: [backend]
supersedes: []
superseded-by: null
---

# Only `semprec-transcribe` runs `ffmpeg`/`ffprobe`

## Context

Transcription step 1 (issue #246) normalizes an uploaded recording to 16 kHz mono Opus with
`ffmpeg` and reads its duration and `creation_time` with `ffprobe`. Both are native binaries, not
npm packages: they have to be installed on the host, every invocation is a child process that can
run for minutes, and every input is a file a user uploaded — a CPU-heavy parser fed untrusted data.

Other processes could plausibly want them as well: probing an upload's duration in `semprec-api`,
say, or rendering a preview. If each caller shelled out on its own, every service's host unit would
need the binaries, and what makes one invocation safe — a timeout that actually kills the process,
cleanup of partial output, validation of what the binary printed — would be reimplemented, or
forgotten, at each call site.

## Decision

`semprec-transcribe` is the only process that runs `ffmpeg` or `ffprobe`. Its production code
spawns them only from `src/mediaNormalization.ts`; its tests also run them, to generate media
fixtures instead of committing binary ones. Concretely:

- They are system packages — installed by `deploy/provision.sh` on the production host and by CI's
  own install step on its runner — never an npm dependency or a bundled static binary.
- Every invocation passes a fixed argument vector with no shell, reads a server-generated temp
  path, runs under a timeout that `SIGKILL`s the process, and validates what it printed before
  anything leaves the module (`ffprobe`'s JSON through zod, `creation_time` down to a canonical
  timestamp).
- Another process that needs media work hands it to `semprec-transcribe` as a queue task with
  `queueAffinity: 'transcribe'` ([[2026-09-22-transcription-queue-affinity-extension]]) rather than
  spawning the binaries itself.

## Consequences

- The binaries are a dependency of one systemd unit (`semprec-transcribe.service`) and one
  provisioning step, not of every service.
- Parsing untrusted media, and the CPU it burns, stays inside the process whose job it is: a hung or
  hostile input can stall that worker for at most its timeouts, never the API.
- Anything that runs `semprec-transcribe`'s integration tests — a developer machine, CI — needs
  `ffmpeg` and `ffprobe` on `PATH`. Its unit tier must not: CI runs that tier before it installs
  them, so every test that spawns either binary is an integration test.
- Enforcement is review: running either binary outside `backend/services/semprec-transcribe/` is a
  finding under `backend/review-rules/rules.md`. No lint rule or CI scan checks it mechanically.
