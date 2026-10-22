# Tenancy

Issue #1058. The production checkpoints of the multi-tenancy rollout (epic #960) and their
outcome.

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
