---
schemaVersion: 1
id: "sp-b8f2605a-a4df-4894-a7dd-d8fadf8d824c"
title: "[areas-removal-debt 04/06] Make the system task isolation case independent of heartbeat timing"
kind: "implementation"
state: "open"
stateReason: null
labels: ["spec:approved"]
parent: "sp-706a1b28-481d-4407-856f-726e4ec0e61a"
assignees: []
milestone: null
createdAt: "2026-11-27T23:25:27.971Z"
updatedAt: "2026-11-27T23:25:29.608Z"
closedAt: null
source: null
approval: {"specSha256":"525b6497daf76a3650fc0c42c9c086b85a41286206cf22cf973e8cb770276af4","source":"repository","actor":"david","at":"2026-11-27T23:25:29.608Z"}
resolution: null
---
**Blocked by:** none
**Model tier:** medium

## Context

Model tier rationale: An intermittent CI failure in a tenant isolation suite needs its cause found in time-dependent heartbeat scheduling, without weakening the isolation assertion.

`backend/services/semprec-api/src/__tests__/tenantIsolationJobs.test.ts:2710` ("system tasks … one run does each tenant's work in that tenant only") failed in the develop push CI after #2114. The bystander tenant's fingerprint gained one `heartbeat_occurrences` row while the system job under test ran. A heartbeat that falls due by wall-clock time can therefore write into a tenant the case treats as untouched.

## Task

1. Find which job or scheduler writes the `heartbeat_occurrences` row during the case, and why it depends on time.
2. Make the case deterministic without hiding cross-tenant writes. For example, the clock the heartbeat reads could be pinned, or the bystander fingerprint could exclude only the rows a time-due heartbeat legitimately creates, with the reason stated.
3. Fix production code instead if the write really breaks tenant isolation.

## Touches

- backend/services/semprec-api/src/__tests__/tenantIsolationJobs.test.ts
- heartbeat scheduling code, only if the cause lies there

## Scope

### In scope

- The intermittent bystander change.

### Out of scope

- Other isolation cases.

## Acceptance criteria

- The case passes whatever the wall-clock time is, and still fails when a system job writes into a bystander tenant.
- The full file passes locally twice.
