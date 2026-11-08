---
status: accepted
date: 2026-10-03
area: [backend]
supersedes: [2026-09-22-transcription-worker-choke-point-access]
superseded-by: null
---

# The agents worker hosts the generic-operation gateway and authenticates as `semprec_data`

## Context

`semprec-agents` connected as `semprec_side` on the premise that it never calls the choke point.
That no longer holds: every agent run gets `createGenericOperationAgentTools(pool, moduleRegistry)`,
which dispatch through `createGenericOperationGateway(pool)` to `createGenericApplicationService(pool)`
and `createChokePoint(pool)`. Non-destructive operations (`item.create`, `item.patch`,
`view.create`, `database.create`) commit directly by design
([[2026-09-18-non-destructive-generic-operations-bypass-agent-approval]]). Under `semprec_side`,
which has only `SELECT` on the choke-point tables, each of them fails with "permission denied",
and `database.create` also lacks `EXECUTE` on `create_items_partition`, granted to `semprec_data`
only. [[2026-09-22-transcription-worker-choke-point-access]] gave `semprec-transcribe` the same
access but stated that all other non-API services remain `semprec_side` consumers, which this
decision reverses for `semprec-agents`.

## Decision

- `semprec_data` goes to `semprec-api`, `semprec-transcribe` and `semprec-agents`, each reading
  `SEMPREC_API_DATABASE_URL`.
- `semprec-transcribe` keeps its rule unchanged: it may use only the generic choke-point package
  to create Transcriptions items and write its declared computed checkpoint, and is the sole
  writer of Transcriptions' `status`, `date` and `link`. Its write extensions from
  [[2026-09-23-transcription-worker-writes-event-match-results]] (the Transcriptions↔Events edge
  and the Processing proposal card) and
  [[2026-09-23-speaker-mappings-are-edges-proposed-on-transcript-cards]] (the transcript proposal
  card) stay unchanged.
- `semprec-agents` writes only through `createGenericOperationGateway`, with its approval gate
  unchanged: destructive operations remain approval requests.
- `semprec_side` stays with `semprec-ai-gateway` and `semprec-restore-test`.
- Direct SQL writes to choke-point tables remain prohibited everywhere.

## Consequences

`semprec-agents` reads the key already present in the shared `/opt/semprec/shared/.env` that its
unit loads, so no unit or operator change is needed and a rollback only reverts the connection
string. No schema changes. Later per-service secret separation and startup role assertions can
assume agents run as `semprec_data`.
