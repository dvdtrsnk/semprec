---
title: Tick approval outcomes use bounded acknowledgment turns
status: accepted
date: 2026-11-09
area: [backend]
supersedes: []
superseded-by: null
---

# Tick approval outcomes use bounded acknowledgment turns

## Context

A tick can request approval and end before the decision arrives. Its outcome must be visible to a continuation, while rejecting the request must not execute the requested action or another tool.

## Decision

The outcome transition writes its system message and, if its tick heartbeat is enabled under reservation, queues an assistant reply in the same transaction. The existing tenant lane and message timestamp allocator order it with other turns. The runner checks the heartbeat again before starting. The source request and its run must belong to the thread and tenant; its settled result is framed as untrusted data with a 32 KiB UTF-8 excerpt limit.

For a rejection, the runner calls `ensureFresh(threadId, null)` before the turn. This existing operation requires an idle cached conversation and pauses it; a busy, waking or dropped entry fails. The new session has no tools. After the acknowledgment the runner pauses it through the same boundary so a later ordinary turn can wake with its normal tools. Cleanup errors are retained alongside a primary turn error.

## Consequences

This boundary applies to rejected approval outcome continuations, not ordinary tick, chat or item turns. It does not introduce a new queue, grant, retry policy or global locking guarantee. The excerpt limit applies after the database result has been decoded.
