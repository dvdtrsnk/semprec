---
status: accepted
date: 2026-11-01
area: [backend]
supersedes: []
superseded-by: null
---

# Keep transcription diagnostics inside storage at the queue boundary

## Context

Gh-1386 allows diagnostic text in `item_automation.error` but forbids it in
responses and logs. Rethrowing a provider or media error from the transcription
task exposes that text to Graphile Worker and the keyed-superseded wrapper.
Sanitizing a single application log does not protect those consumers.

[[2026-09-30-graceful-shutdown-for-long-running-graphile-worker-tasks]] owns the
successful shutdown/re-enqueue path. This decision preserves that behavior and
the existing retry, budget-refusal, deletion-stop and permanent-failure policy.

## Decision

The outer transcription handler converts every escaping task failure, including
setup and pre-transcript failures, into a typed error with a fixed message and
an approved stable code. It carries no original cause, body, arbitrary error
properties or diagnostic text. Classification and the existing diagnostic
storage happen before conversion when a transcript exists. A failure while
recording diagnostics must not expose either exception or replace the original
failure classification with the recording failure.

Logs in this failure and media-cleanup path contain fixed messages and checked
codes or IDs only. The typed outward error may be logged or stored as the
queue's failure without recovering the original diagnostic. Actual owned
worker tests must cover retry/final failure and keyed supersession, with
distinct sentinels for original and recording/cleanup failures.

The handler still rejects where it previously rejected; successful stop,
budget refusal and shutdown branches still return normally. There is no new
retry policy, queue wrapper, generic error serializer or provider call.

## Alternatives rejected

- Rethrow the original error after a safe application log. Queue consumers can
  still serialize its message, cause or fields.
- Return success after every error. That loses retries and changes job state.
- Sanitize every queue task globally. This issue owns transcription failures;
  independent queue infrastructure errors require their own scoped decision.

## Consequences

Direct task callers receive a safe classified error rather than original error
identity. Operator diagnostics remain in their existing storage when that write
succeeds. Pre-transcript failures have no invented automation row. This does
not assert that unrelated queue infrastructure or other tasks are content-safe.
