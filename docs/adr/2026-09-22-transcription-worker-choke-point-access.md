---
status: accepted
date: 2026-09-22
area: [backend]
supersedes: [2026-09-17-two-tier-runtime-database-roles]
superseded-by: null
---

# The transcription worker hosts its narrow in-process choke-point writer

## Context

The transcription pipeline must create and checkpoint Transcriptions rows in its own queue
process. Routing that write through `semprec-api` would make a job's durable checkpoint depend
on a second process and split its transaction. The preceding two-tier-role decision assigned
all choke-point access to the API, which cannot support this required in-process transaction.

## Decision

`semprec-transcribe` receives `semprec_data` credentials and may use only the generic
choke-point package to create Transcriptions items and write its declared computed checkpoint.
It is the sole writer of Transcriptions' `status`, `date`, and `link` system-owned properties.
All other non-API services remain `semprec_side` consumers, and direct SQL writes to
choke-point tables remain prohibited.

## Consequences

The shared deployment environment gives the transcription unit access to the data connection
string. Its narrow system-key allowlist makes the process identity enforceable in code while the
catalog's `owner_process = 'transcribe'` makes ownership drift observable.
