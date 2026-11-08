---
status: accepted
date: 2026-11-02
area: [backend]
supersedes: []
superseded-by: null
---

# SMTP and IMAP sync isolate secret-bearing provider failures

## Context

Gh-1634 forbids passwords and message bodies in SMTP errors. Gh-1510 forbids
passwords in IMAP sync errors, logs and last_error. An arbitrary library failure
can contain these in its message, name, code, nested cause or non-Error value.
Passing unknown failures through preserves identity but violates these explicit
privacy requirements. Initial connection mapping alone misses later IMAP calls,
lazy download failures and logging before recovery or close.

[[2026-10-18-fatal-shutdown-rejection-and-mail-failure-logs]] disallows raw mail
errors in logs but its name/code projection is insufficient for arbitrary
values. [[2026-11-02-mail-verification-sanitizes-unknown-failures-at-its-public-boundary]]
selects an internal/outward distinction for verification only. This decision
extends that distinction to the two boundaries below, not to all mail code.

## Decision

Retain actual primary/secondary values and explicit presence, including
undefined, within the operation owner through its owned settlement, cleanup
and diagnostic processing. Cleanup cannot replace an established primary.
At a privacy boundary, replace an unknown provider failure with a fresh fixed
generic Error without cause, original properties or aggregate members. Do not
infer authentication, recipient refusal, connection limit or unreachability
from an unknown failure. Do not inspect arbitrary names/messages for redaction.
Known classifications keep their semantics but use fresh fixed safe errors,
not mutable original instances with potentially modified text/properties.

1. The SMTP boundary is createSmtpMailTransport.send, including synchronous
   opener, send and classification failures. Close each obtained transporter
   through the existing owner; an opener that never returns remains responsible
   for resources it acquired. Preserve the existing auth/recipient/unreachable
   mapping and send timeout. Do not retry a failed or ambiguous send here.
   Once SMTP accepted the message, close or optional Sent-copy failures retain
   the existing accepted-send result and get safe diagnostics: do not convert
   them into a delivery failure that invites duplicate submission. This does
   not claim a failed close succeeded, or a missing Sent copy exists.
2. The IMAP initial-connect boundary is openMailboxImapClient, after the
   existing auth/connection-limit/unreachable classification. Later provider
   failures are isolated at private ImapFlowMailClient library calls and lazy
   stream acquisition/iteration, before they can escape to reconcile and the
   job's recorder. Keep catches around those provider operations, not around
   SQL, choke-point/domain writes, parsing unrelated to a provider operation,
   ingest or blob storage. Preserve known cap/domain errors and fallback
   behavior. No blanket mapper in the job's outer catch or last_error writer.
   A propagated unknown provider error is generic; existing job recording and
   retry see that safe error. Non-network failures keep their original types,
   identity and transaction behavior. This intentionally changes unknown
   library-error projection for the reused ImapFlowMailClient, not its data,
   timeout, fallback, ownership or known-error contracts.

Use fixed closed stage/category tags, counts and necessary stable identifiers
for existing diagnostics. No raw error, arbitrary name/code, host, server text,
credential or message bytes may be logged at these touched connection, stream,
close and transport failure sites. Shared connection helpers keep their
existing error mapping, policy and timeout behavior; only their unsafe log
projection changes. Existing quiet close and recovery semantics remain; every
observed failure still has a safe diagnostic. Diagnostic/classification failure
must not leak its own raw value, replace the primary or cause resubmission after
acceptance. Do not claim a failed diagnostic was published. No new durable raw
error store, public raw-error hook, generic filtering framework or global patch.

## Consequences

Raw provider details are intentionally unavailable to callers and persisted
sync errors. A generic failure remains failure rather than a false known
diagnosis. Tests must independently observe actual producers and owned cleanup
to establish internal identity, then assert safe outward/stored/serialized
results. Include opener/send and post-connect/lazy failures, secret-bearing
name/message/code/nested values, undefined/non-Error, combined cleanup failure,
accepted-send close/copy failures, and unchanged genuine known outcomes. Prove
SQL/domain/storage rejection identity is not converted by IMAP isolation.

Use the existing local fake servers and forwarding observations, without live
credentials. This does not authorize changing SMTP delivery/recipient policy,
IMAP address policy, database transactions, reconciliation data semantics,
other provider transports or verification's separate cancellation contract.
