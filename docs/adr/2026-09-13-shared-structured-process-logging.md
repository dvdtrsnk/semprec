---
status: accepted
date: 2026-09-13
area: [backend]
supersedes: []
superseded-by: null
---

# Shared structured logging and fatal process handling

## Context

Semprec runs several independently deployable process types, including the API,
AI gateway, agents, mail sync, and transcription. Ad-hoc `console` calls make
their output difficult to correlate when container stdout is multiplexed and
leave each process to choose its own failure behavior. A process that continues
after an uncaught exception or unhandled rejection can serve a partially broken
runtime state.

## Decision

All process types use the logger factory in `@semprec/shared` to create a named
root logger. The logger emits newline-delimited JSON to stdout only, with the
process name on every record.

The factory centrally redacts authorization headers and password, token, and
credential fields. `LOG_LEVEL` selects the active level at process startup;
`info` is the default and diagnostic levels remain opt-in.

Each executable process entrypoint installs the shared uncaught-exception and
unhandled-rejection handlers before startup work. A handler writes one fatal
record and terminates the process with a non-zero status so its supervisor can
restart it.

## Consequences

- Logs can be queried and correlated consistently across process types without
  per-service file transports or a logging side channel.
- Process restarts pick up a changed `LOG_LEVEL` without rebuilding an image.
- A future executable process must create its named root logger and install the
  fatal handlers in its own entrypoint before performing startup work.
