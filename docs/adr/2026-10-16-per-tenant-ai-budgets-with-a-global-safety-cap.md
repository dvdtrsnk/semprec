---
status: accepted
date: 2026-10-16
area: [backend]
supersedes: [2026-09-27-ai-budget-reservations-under-a-global-advisory-lock]
superseded-by: null
---

# Per-tenant AI budgets with a global safety cap

## Context

[[2026-09-27-ai-budget-reservations-under-a-global-advisory-lock]] made the
gateway reserve before it calls a provider, under one global advisory lock,
against two caps read from the single System settings item. With several
tenants, those caps are no longer one user's choice: each tenant needs its own
limits, owned by the operator, and the operator needs a ceiling over everyone's
combined spend. Every `ai_gateway_calls` row carries its tenant, and the
gateway runs as `semprec_side`, so row-level security shows a reservation only
its own tenant's rows.

## Decision

**Kept from the superseded ADR:** the reserve/settle/fail lifecycle, counting
every row at its `cost_usd` with no status filter, the transaction-scoped lock
released at COMMIT before the provider call, and the single lock key
`pg_advisory_xact_lock(hashtext('ai_gateway_budget'))`.

**Two caps are checked in the same critical section, after the lock.** A call
is refused when `spent >= cap` for any of:

1. **The tenant's caps**, from its row in the admin-owned `tenant_ai_budgets`
   table. A tenant without a row is refused every call, including a call where
   no tenant resolves (fail closed). A `NULL` `daily_cap_usd` or
   `monthly_cap_usd` means that window has no per-tenant cap; the global cap
   still applies to it. The tenant's spend is its own rows (row-level
   security), with the day and month boundaries in the timezone of the tenant's
   own settings item.
2. **The operator-wide safety cap**, from the required environment variables
   `AI_GLOBAL_DAILY_CAP_USD` and `AI_GLOBAL_MONTHLY_CAP_USD`, against the spend
   of all tenants, with the day and month boundaries in UTC. The sum crosses
   row-level security through `ai_global_spend()`, a `SECURITY DEFINER`
   function owned by `semprec_router` that returns only two numbers
   ([[2026-10-07-cross-tenant-router-functions]]).

**The refusal is identical for every cause.** It is a `BudgetExceededError`
with the constant message `AI budget exceeded`, so the 403 body is the same
whichever cap tripped and a tenant cannot infer other tenants' spend from it.
The gateway logs which limit refused (`noTenantBudget`, `tenantDaily`,
`tenantMonthly`, `globalDaily`, `globalMonthly`) at `warn`, with no amount and
no content. A refusal rolls the reservation transaction back, so no row is
inserted.

**Rejected: a lock key per tenant.** Per-tenant keys would let different
tenants reserve concurrently, but a global cap is only enforceable when every
reservation is serialized at one point: two tenants holding different keys
could each read the same global spend and together overshoot it.

## Consequences

- The gateway cannot start without both `AI_GLOBAL_*` variables; they must be
  set before this release is promoted.
- The check-and-insert now does three indexed reads (the tenant budget row, the
  tenant spend through `ai_gateway_calls (tenant_id, at)`, and the global sum)
  inside the one global lock, so throughput is still bounded by that
  transaction. The global sum scans the rows of the current UTC month.
- The settings-item properties `dailyBudgetUsd` and `monthlyBudgetUsd` are no
  longer read by the gateway. Migration 0073 copies the values of any
  `tenant_ai_budgets` row no admin has written (`updated_by IS NULL`) from the
  settings item once more, so an edit made since the table was seeded is kept.
- During a rolling deploy the previous release still enforces the settings
  caps only; it does not see the global cap.
- A settle that fails still leaves its row `reserved` at its estimate, as
  before; this decision adds no reclaiming sweep.
