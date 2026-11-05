---
status: accepted
date: 2026-11-05
area: [backend]
supersedes: []
superseded-by: null
---

# Value-link job keys include the trusted tenant

## Context

[[2026-11-05-value-link-propagation-keeps-separate-hop-budgets]] says tenant
namespacing remains the queue envelope. The actual enqueueJob owner stamps
scope into payload but passes jobKey unchanged to Graphile's global key.
The envelope therefore does not prevent cross-tenant key replacement.
This record corrects only that tenant-key clause; the hop decision remains.

## Decision

The value-link domain producer constructs the exact key
`valueLinksPropagate:<tenantId>:<ruleKey>:<sourceItemId>:<hop>`.
Read tenantId from the existing trusted active tenant scope, never the payload;
reject missing or system scope before enqueue. The fixed prefix distinguishes
the task, tenant UUID distinguishes tenants, and the already validated rule,
source UUID and hop identify the existing same-budget work. Resolve the rule
through the existing domain catalog and validate source UUID and hop through
the existing job boundary. Do not add a new rule-key syntax restriction.

Do not change enqueueJob, Graphile internals, the queue envelope or tenantLane.
All other hop-budget, replace, transaction and no-op scheduling decisions remain
as recorded in the referenced ADR. Existing queued keys may drain unchanged;
this authorizes no queue rewrite or stronger mixed-version scheduling claim.

## Consequences

Equal-budget work in one tenant collapses as before. Identical logical rule,
source and hop in distinct tenant scopes have distinct keys and retain their
own envelopes. Exercise that distinction and same-tenant collapse through the
existing domain producer and real queue test harness. No new general queue
key namespace or persistence protocol is introduced.
