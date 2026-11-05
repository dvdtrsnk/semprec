---
status: accepted
date: 2026-11-05
area: [backend]
supersedes: []
superseded-by: null
---

# Library retries require a supported live source configuration

## Context

The metadata dispatcher must reject unknown source configuration, while gh1708
retries provider failures and notFound daily. A three-attempt queue batch does
not prevent another batch every day. The existing durable heartbeat/job config,
not another outcome status, can distinguish a configuration refusal.

## Decision

A small pure libraryMetadataConfig.ts owns the supported configured-source set
(none, openLibrary, tmdb) and a fixed-message LibraryMetadataConfigurationError.
Google Books is a fallback/result source, not a configured dispatcher branch.
Never echo a supplied config value, exception or credential in this error.

Validate before ensureItemAutomation/enqueue, before a retry sweep reads rows or
enqueues any batch, at job entry before automation outcome processing, and in
the dispatcher. A recognized configuration error is outside gh1708's generic
thrown-provider-error mapping. It changes no item/automation row and performs
no fetch; it does not masquerade as done, notFound or a user lock. Existing
legacy queued invalid jobs may fail their bounded maxAttempts=3 batch. The same
unsupported live heartbeat config cannot enqueue a new metadata batch. Once it
is repaired, normal sweep eligibility uses the supported current config.

A scheduler may still report a fixed configuration failure according to its
existing policy; this decision does not cancel scheduler schedules or promise
that all heartbeat retries cease. Missing TMDB credentials remain the explicitly
specified sourceUnavailable provider outcome; do not widen this exception.

## Consequences

No new table, retryability flag, status/code literal, queue internals or permanent
failure framework. Preserve runtime config validation and safe queue failure
privacy. Test direct dispatcher refusal, producer rejection before side effects,
legacy queued invalid-job bounded failure and repeated invalid sweep with no new
metadata batch, plus repaired-config and ordinary provider/notFound retry controls.
The raw error_code/source outcome and reader-bridge contracts are unchanged.
