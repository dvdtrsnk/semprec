# Tenancy

Issues #1058 and #1068. The production checkpoints of the multi-tenancy rollout (epic #960) and
their outcome.

## Release checkpoint

**Waived on 2026-10-22 by the repository owner. Nothing below was observed in production.**

Issue #1058 asks for a context-complete release to run in production for seven days before
the contract and strict steps (#1059–#1067) merge. The waiting protects the one-release
rollback rule ([migrations.md](migrations.md),
[ADR](../adr/2026-09-24-rollback-one-release-back-with-checked-migrations.md)):
`deploy/deploy.sh --rollback` starts the previous release against the new schema, so that
previous release must already carry the tenant scope on every path.

On 2026-10-22 no production deployment of Semprec exists. No host has been provisioned with
`deploy/provision.sh`, no release tag exists, and `main` was last promoted on 2026-08-27
(PR #57). There is no running release to roll back to and no production log to read, so the
evidence the checkpoint asks for cannot exist. The repository owner therefore waived the
checkpoint instead of provisioning a host only to observe it.

What this means for each checklist item of #1058:

| Checklist item                                                    | Result                                                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `AI_GLOBAL_DAILY_CAP_USD` and `AI_GLOBAL_MONTHLY_CAP_USD` set     | Not done: no gateway environment exists                                                          |
| Promote `develop` to `main`, tag and deploy                       | Not done: promotion PR #1229 stays open, no tag, no deploy                                       |
| `SEMPREC_TENANT_SCOPE` unset or `warn` for every service          | Not done: no service runs                                                                        |
| The tag's `integration` job green, including the isolation suites | No tag. `integration` passed on PR #1229 at `develop` `3c40b63ba1eb20a33e7928e9d6410c379696fe03` |
| Exactly one tenant and `tenants_single_tenant_guard` present      | Not done: no production database                                                                 |
| No user without a tenant                                          | Not done: no production database                                                                 |
| Seven days without `tenant_scope_missing`                         | Not observed                                                                                     |
| Seven days without `tenant_task_without_tenant`                   | Not observed                                                                                     |
| Legacy envelopes drained, permanently failed legacy jobs handled  | Not done: no production queue                                                                    |

The first production deployment will therefore already contain the contract and strict steps,
with no earlier production release that `deploy/deploy.sh --rollback` could return to.

## Strict release checkpoint

**Waived on 2026-10-22 by the repository owner. Nothing below was observed in production.**

Issue #1068 asks for the strict release (#1059, #1060, #1062, #1067) to run in production for
seven days before the contract steps whose rollback target must already be strict, in
particular retiring the master-key-only credential scheme (#1069). It is waived for the same
reason as the release checkpoint above: no production deployment exists, so there is no strict
release to observe and none for a rollback from #1069 to return to.

What this means for each checklist item of #1068:

| Checklist item                                                                                        | Result                              |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Promote `develop` to `main`, tag and deploy                                                           | Not done: no tag, no deploy         |
| No service sets `SEMPREC_TENANT_SCOPE` other than `strict`                                            | Not done: no service runs           |
| `app_tenant_default()` strict and `users.tenant_id` not nullable in production                        | Not checked: no production database |
| No `external_credentials` row with `scheme = 'master'`                                                | Not checked: no production database |
| Seven days without `TenantScopeMissingError`, `tenant_scope_missing` and `tenant_task_without_tenant` | Not observed                        |
| Background work kept running under strict mode for the window                                         | Not observed                        |

The go-live security gate #1086, which follows this checkpoint, still gates the production go-live of a second tenant. It no longer blocks implementation dispatch: code that drops the single-tenant guard (#1087) may merge, but a second tenant must not be deployed until #1086 is signed.

## Security gate

**2026-11-03 — BLOCKED / NOT READY FOR PRODUCTION. No second-tenant go-live is authorized.**

The delegated program supervisor is parent controller `thr_pz39tcih5r`, under
[owner-delegated backend supervision](../adr/2026-10-31-owner-delegated-backend-program-supervision.md).
This is the interim evidence and disposition record for [gh-1086](../../issues/items/gh-1086.md),
not its completion or a production sign-off. Both gh-1086 and its batch 19 aggregate remain open.
The earlier checkpoint waivers above are historical owner decisions; they do not waive this gate.
This local program has not inspected a current production deployment, service environment,
backup or log. The dated absence of production above is not a claim about current host state.

The reviewed local commit is `7550fba23bcd86cc963287797d2ec07ed8832c13`, tree
`7d763b49dc881ccfb8210deb664015681b3aacbd`. Independent reviewer thread `thr_icb45eea4g`
completed one bounded static R1, separate from the implementation/controller context, with verdict
**NOT CLEAR**. Requested configuration was `gpt-6.1-terra` / `xhigh`; the reviewer exposed only
Codex based on GPT-6, so the exact runtime variant and effort are not independently attested.
Its report is retained in controller thread storage at
`batch-19-run/independent-review/r1-final.md`, SHA-256
`b9335aeacd8ff9f9929a142a22762420e52a4ab61954540785fbd0af4b77c5f7`.
No tests, services, production checks or additional reviewers ran as part of that static review.

### Checklist evidence

| Required check                                                            | Result  | Evidence and remaining requirement                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strict, twice                                                             | BLOCKED | No two production release tags have been evidenced. The strict checkpoint above is a waiver, not an observed strict release or a rollback target.                                                                                                                                                              |
| No escape hatch                                                           | NOT RUN | Effective environments and environment files of every deployed service have not been inspected. Static configuration is insufficient.                                                                                                                                                                          |
| Latest deploy invariants                                                  | NOT RUN | No current deploy output is available. `tenancy: verified` covers the verifier's declared predicates; it is not independent proof of every effective policy expression or function body.                                                                                                                       |
| Clean logs                                                                | NOT RUN | No production journal or content-free tenant-attributed sample has been inspected.                                                                                                                                                                                                                             |
| Isolation suites on deployed tag                                          | NOT RUN | R1 traced runtime-role, two-tenant REST/MCP, realtime, background and gateway test designs. This is static evidence, not a deployed-tag integration result.                                                                                                                                                    |
| Host secrets, migrate URL, egress, sandbox, access logs, cache, max locks | NOT RUN | Service files, firewall declarations and application mechanisms were inspected statically. Effective host settings, network refusals and actual responses remain unobserved.                                                                                                                                   |
| MCP member/admin and connection policy                                    | NOT RUN | Static role checks, dedicated launcher and connection-time address checks were inspected. Actual deployed launcher identity and private-address refusal remain unobserved.                                                                                                                                     |
| Tenant-zero and global AI caps                                            | NOT RUN | No live budget row or deployed gateway cap environment has been inspected.                                                                                                                                                                                                                                     |
| Backups                                                                   | BLOCKED | No live snapshot or key-retention evidence has been inspected. Key compatibility and dump/ledger findings F2/F3 below remain open.                                                                                                                                                                             |
| Restored scratch rehearsal                                                | BLOCKED | No production-backup rehearsal has run. Restore activation, key compatibility and dump/ledger findings F1–F3 below must be resolved first.                                                                                                                                                                     |
| Independent adversarial review and finding dispositions                   | PARTIAL | Complete static R1 is recorded above; concrete findings F1–F3 have separate open corrective issues. It does not grant security clearance.                                                                                                                                                                      |
| Retention disclosure and invitation communication                         | PARTIAL | Deleted content can remain in encrypted long-retention backups until the 12-month retention expires. Key erasure depends on the separately retained key snapshots and successful backup/prune operation; it is not established here. Disclosure to actual invitees has not been observed and remains required. |
| Gate record, release tags and supervisor decision                         | PARTIAL | This dated interim record exists. The two tags, live evidence, closed corrective findings and final security decision remain outstanding.                                                                                                                                                                      |

### Independent findings and parent dispositions

- **F1, high — activation before refused deletion replay is resolved. Confirmed and blocking.**
  The restore runbook starts services before addressing a CLI refusal. A restored ledger-listed
  tenant can remain unchanged on `lastAdmin` or `unexpectedStatus`. Corrective issue
  [sp-a0f046dd-8781-4141-bc04-5dad0b725faf](../../issues/items/sp-a0f046dd-8781-4141-bc04-5dad0b725faf.md)
  owns a fail-closed activation sequence and evidence. No last-admin guard is waived.
- **F2, high — newest key dump can be incompatible with an older main dump. Confirmed and blocking.**
  A newer key can reference a tenant absent from the older main snapshot and fail its foreign key.
  Corrective issue [sp-94a5c71d-4663-4014-9256-db63e179346e](../../issues/items/sp-94a5c71d-4663-4014-9256-db63e179346e.md)
  owns the compatible-key restore contract, constrained import and actual PostgreSQL evidence.
  It does not authorize recovering erased keys from older snapshots or disabling target constraints.
- **F3, medium — independently observed dump and ledger can describe different instants. Confirmed and blocking.**
  A purge between the dump snapshot and ledger query can make a valid newer ledger fail the monthly
  test's exact-snapshot check. Corrective issue
  [sp-dd171464-d76c-45f9-b113-73d81b38aad4](../../issues/items/sp-dd171464-d76c-45f9-b113-73d81b38aad4.md)
  owns explicit snapshot-versus-replay semantics and controlled concurrent evidence. Newer deletion
  evidence must not be discarded merely to make the test pass.
- **F4, medium — deploy verifier coverage. Accepted as an explicit bounded-tool limitation, not production isolation proof.**
  The current implementation follows gh-1085's eight specified predicates. Its policy names,
  flags and helper string checks do not detect arbitrary privileged changes to policy expressions,
  function bodies or effective grants. No such current misconfiguration or public exploit was
  demonstrated. Correct code is not changed merely to broaden that earlier issue's contract.
  Production sign-off still requires effective catalog/policy/grant evidence in addition to the
  verifier output. This disposition does not turn an uninspected catalog into PASS.
- **F5, high — native runtime package resolution. Retained readiness blocker.**
  The [existing prerequisite](../../issues/batches/backend/followups/native-runtime-package-resolution.md) and corrective issue
  [sp-62b97861-bb73-46ec-83d7-2dcfd881b16a](../../issues/items/sp-62b97861-bb73-46ec-83d7-2dcfd881b16a.md)
  record failure of the native compiled migration entry after build. A test-only resolver does
  not establish native deployment executability. A separately approved packaging repair and actual
  native entrypoint evidence are required before deployment readiness.
- **F6 — unavailable production evidence, full verify and historical cleanup. Retained blockers and exact limits.**
  The latest actual full backend verification, on batch 18 candidate `a468446a`, remained FAIL with
  the exact MCP inherited-name mismatch (`__CF_USER_TEXT_ENCODING`). Its candidate-local integration
  exception does not transfer to this gate. Separate integration 812/812 and complete E2E 44/44
  remain distinct successes. Earlier CLI fixture DROP timeouts did not establish individual
  database removal; global PostgreSQL shutdown or a later summary cannot settle that historical
  uncertainty. Neither fact is a production security PASS.

### Activation boundary and continuation

The recovered local code already contains migration `0123_drop_single_tenant_guard.sql` and
invitation acceptance. A fully migrated local database therefore must not be described as
physically protected by that removed index. The migration's operational go-live precondition
remains in force: this documentation is not a runtime switch or permission to expose a second
account. No deployment, real invitation, production restore or production security approval has
been performed by this gate.

The supervisor retains the original R1 verdict and all unavailable evidence. Corrective issues
are separate work, not silent scope expansion of gh-1086. Under the currently approved batch
criteria, batch 19 is incomplete and sequential advancement is held. Any future adjustment of
obsolete deployment assumptions requires an explicit specification/decision update; missing,
failed or simulated checks must retain their actual results.

### Owner-directed local continuation (2026-11-03)

The owner now directs autonomous continuation under
[[2026-11-03-local-development-continues-with-open-production-gates]]. This later
decision changes the local sequencing hold described above, not the historical
R1 report or production evidence. Batch 19's four local corrective issues have
reviewed, tested fixes and candidate-specific local acceptance; its aggregate
may close its LOCAL lane while gh-1086 remains OPEN. Full verify still failed
four tests on 716939c6; exact local exceptions and historical cleanup uncertainty
are recorded in `issues/batches/backend/decisions/batch-19-local-continuation.md`.

Production security result: **BLOCKED / NOT RUN**. The strict release tags,
effective deployed policy/grants and host configuration, live backup/restore
rehearsal, invitee disclosure and final security decision are not established.
No deployment, production access or real second-account invitation is authorized.
Subsequent backend implementation does not satisfy or erase these obligations.
