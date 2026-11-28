# Acceptance receipt: sp-f255e6c6-e1ef-4adc-a47c-c24746bb4a3b

**Title:** [security-gate 03/06] Make the offline restore work on a fresh cluster and never import the key of a deleting tenant

- Chain: `e1-245-backup-restore` (one member), branch `chain/e1-245-backup-restore`, cut from `b84bf22e2bd023db4a5379e771c1203d1b463e8f`.
- Landed alone (no train). Integration tip before the merge (`PRE`): `faf0731ca59c723668aa1acbcdf48ec5ae902122`.
- Candidate commit of the chain: `71afa79db34b8364d1442522f1ebf0fce6b2aa5b`.
- Segment commit of this source: `71afa79db34b8364d1442522f1ebf0fce6b2aa5b`.
- Merge commit of the chain: `5479387c468d1dc60a76319897019d8a55a2e466` on `feature/backend-parallel` (`--no-ff`); the gate ran on its tree.
- Conflicts resolved at the merge: none (automatic merge; no shared registry, barrel, manifest or catalog is touched). Migrations renumbered: none (the chain adds no migration).
- Declared blockers: `check-blockers.mjs --file-order-may-wait` exited 0 and lists no `undeliveredBlockers` and no `fileOrderBlockersStillOpen` for this source.
- Controller note: none.
- Handover: `issues/handovers/sp-f255e6c6-e1ef-4adc-a47c-c24746bb4a3b.md`.

## Specification

The record is `issues/items/sp-f255e6c6-e1ef-4adc-a47c-c24746bb4a3b.md`. Worker summary: the monthly restore test creates `alldots_side`, `alldots_data` and `alldots_router` before `pg_restore` and records a failed role statement as the check `clusterRoles`; `importStagedTenantKeys` refuses a deleting tenant and a tenant tombstoned in `tenant_deletions`; the ledger validator prints one fixed line per failure class through `restoreLedgerFailureMessage` and `RestoreLedgerMismatchError`; `deploy/README.md` gains the marked restore-database-command block and the `clusterRoles` and key-import rules; a new ADR records the decision. Worker deviations: (1) the two shell tests need GNU `sed`/`stat`, so the worker ran them with shims; (2) failure-class precedence in an `AggregateError` is mismatch, privilege, unreachable (the Task states none); (3) the runbook block takes the main snapshot ID and writes the main dump with `restic dump`, and the owner check runs before role creation; (4) one extra compiled-validator CLI test; (5) the role-less restore test uses a second docker fixture and a recreated database.

## Review

| Reviewer | Verdict |
| --- | --- |
| Requirements and tests | clear (no finding; all six criteria covered) |
| Rules and architecture | clear (no finding) |
| Security | clear (no finding) |
| Recheck | not run: no finding, no fix round |

No finding. The reviewers state they were read-only and ran no tests.

## Evidence

Criteria, tests and statuses are the worker's from `worker.json`, cross-checked with the requirements reviewer's coverage rows. The landing ran `backupKeyRestore.test.ts` (plus `restoreTestResult.test.ts` and `backupDeletionLedger.test.ts`), the unit tier (which holds `restoreLedgerFailure.unit.test.ts` and `restoreTestResultArgs.unit.test.ts`) and, by hand with GNU shims, the two shell tests on the merged tree; all passed. It did not repeat the worker's mutation runs and did not re-read every test body.

| Criterion | Test | Status |
| --- | --- | --- |
| Monthly test on a dump with a `alldots_side` policy and a `alldots_router`-owned function passes `pgRestore`; fails there on the unfixed script | `backupKeyRestore.test.ts`: runs the monthly script with real owned bridge, compiled owner and synthetic snapshots (the fail-before half is the worker's mutation run, not repeated) | PASS |
| Real migrated catalog restored with the monthly flags into a role-less cluster fails naming `alldots_side`; after `CLUSTER_ROLES_SQL` it exits 0 | `backupKeyRestore.test.ts`: restores a dump of the real migrated catalog into a role-less cluster with the script's role statement | PASS |
| A failing role statement fails the run with check `clusterRoles` and no `pg_restore` | `alldots-restore-test.test.sh` (assert_failure clusterRoles, no `pg_restore`, role statement before the first `pg_restore`), run by hand with GNU shims | PASS (not part of the automated gate) |
| The recorder accepts `clusterRoles` as a failed check | `restoreTestResultArgs.unit.test.ts`: parses a failure at the clusterRoles check; `restoreTestResult.test.ts` | PASS |
| Staged keys of a deleting and of a tombstoned tenant are not imported; the active tenant's key is | `backupKeyRestore.test.ts`: imports only the key of an active tenant and skips a deleting and a tombstoned tenant | PASS |
| The ledger validator prints the matching fixed line and exits 1 for privilege, unreachable or login-refusing database, and mismatch; nothing else is printed | `restoreLedgerFailure.unit.test.ts` (all branches) and `backupKeyRestore.test.ts`: prints the fixed ledger failure line of the compiled validator and nothing of the failure | PASS |
| The README restore block extracted and run with shims: roles before `pg_restore`, no `--no-owner`/`--no-privileges`, both blob directories, newest key dump by path, key CLI last, no password in any argument, stops before `pg_restore` when the owner role is missing | `alldots-restore-activation.test.sh` (restore-database-command section), run by hand with GNU shims | PASS (not part of the automated gate) |

No criterion is FAIL or BLOCKED. The README block was exercised only with shims for `psql`, `pg_restore`, `restic` and `node`; no real restic repository, production cluster or the gh-1086 rehearsal was used (that stays with the open release gate gh-1086).

## Landing gate

Run on the merge tree `5479387c468d1dc60a76319897019d8a55a2e466` (the merge was completed from the gated working tree without changes), in `backend/` with `npx -y pnpm@9.12.0`. Logs: the `land/` directory of the thread-storage run directory of the chain. No step was repeated and nothing was treated as host load.

| Step | Result |
| --- | --- |
| `install --frozen-lockfile` | NOT RUN (the lockfile and package manifests are unchanged by the chain) |
| `-r run build` | PASS |
| `run lint` | PASS |
| `run format:check` | PASS |
| `run test:unit` | PASS (241 files, 4842 tests, plus 4 files, 172 tests of block-model; the `mcpConnectionFactory.test.ts` baseline failure of the host did not appear) |
| `run check:pi-import-paths` | PASS |
| `--filter @alldots/data run check-migration-numbering` | PASS (175 migration files, unique ordinals) |
| `run check:write-safety` | PASS (111 unsafe writes and 13 leaked connects, all in the baseline) |
| `run test:repo-scripts` | PASS |
| `run check:boundaries` | PASS (no dependency violations, 7547 modules) |
| `run test:e2e` | PASS (6 files, 52 tests) |
| `exec vitest run --config vitest.integration.config.ts` with `backupKeyRestore.test.ts` (changed by the chain) plus `restoreTestResult.test.ts` and `backupDeletionLedger.test.ts` (unchanged, cover the code the chain touched) | PASS (3 files, 32 tests) |
| `node .github/scripts/adr.mjs` (repository root) | PASS (exit 0; lists the new ADR as accepted, backend) |
| `alldots-restore-test.test.sh` and `alldots-restore-activation.test.sh` with GNU `sed`/`stat` shims (extra, by hand) | PASS |

The chain touched no shared registry, barrel, manifest, catalog, route matrix slice, hook registry, tenant cutover list or generic operation, so no validating suite of a shared file was required.

NOT RUN in this landing: `install --frozen-lockfile` (lockfile unchanged), the whole integration tier, the workers' mutation checks, web and mobile. Nothing is FAIL or BLOCKED.
