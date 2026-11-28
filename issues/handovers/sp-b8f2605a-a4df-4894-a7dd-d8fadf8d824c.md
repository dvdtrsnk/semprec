## What was delivered

- Cause: tenant zero (the bystander of the heartbeatSweep system case) carries seeded daily heartbeats, among them "Tasks day rollover" at 00:00 and "Refresh next occurrence of recurring events" at 00:05 in the system timezone (Europe/Prague). Their next_fire_at is computed when the test template is seeded. The failing develop shard ran 22:56-23:07 UTC, crossing 00:00 Prague, so the sweep legitimately fired the bystander's own day rollover heartbeat (one heartbeat_occurrences row, project_heartbeats.next_fire_at advanced). Production behaviour is correct; no isolation breach.
- Fix (test only, backend/services/semprec-api/src/__tests__/tenantIsolationJobs.test.ts): SystemTaskCase gained an optional holdBystander hook. The heartbeatSweep case defers every bystander heartbeat with a next_fire_at by one day before the bystander fingerprint is taken and restores the original values after the assertions (in settled cleanup). The bystander fingerprint still covers every tenant table.
- Checked locally: with a bystander heartbeat forced due and the hold disabled the case fails with the CI diff; with the hold it passes; an injected write into the bystander after the run still fails the case.

## Contracts dependents build on

- SystemTaskCase.holdBystander(tenant) returns a restore function; the system task case body calls it for each bystander before fingerprinting and runs every restore in cleanup.
