---
status: accepted
date: 2026-11-10
area: [backend, web, mobile]
supersedes: []
superseded-by: null
---

# Semp status problems derived at read time have no row

## Context

`GET /api/semp-status` (gh-1555) lists the active rows of `semp_problems`.
Producers raise and resolve those rows, and one row is one episode
([[2026-11-03-semp-problem-occurrences-retain-episode-receipts]]). The summary
(gh-1631) returns the id of the banner's problem as `instanceId`, and a client
hides a notice until that value changes.

gh-1871 adds two problems for the tenant's AI budget: the tenant has no budget
row, or a cap of its own is reached. Both states are already determined by
`tenant_ai_budgets` and `ai_gateway_calls`
([[2026-10-16-per-tenant-ai-budgets-with-a-global-safety-cap]]), and the epic
gh-1310 decided to derive them when the status is read, with no table row and
no nightly job. The alternative was a stored problem: the gateway would raise a
row when it refuses a call, and something would resolve it at the reset
instant. That needs a write from a refusal whose transaction rolls back, a
resolving job for every exhausted window, and a second copy of a state that
goes stale when an administrator changes the caps.

Nothing recorded what a problem without a row is to the rest of the status
contract: its id, its place in the order and the count, and what it lacks.

## Decision

A status problem may be **derived at read time** from state that another owner
already stores. `readSempStatusReport` evaluates it inside the report's own
transaction and writes nothing. It is never inserted into `semp_problems`.

- **Fields.** A derived problem has the fields of a stored one. Those that
  describe a row have fixed values: `since` is `null` because no start instant
  is recorded, `mergedCount` is 1, `projectName` is `null`, and `source` names
  the table the state is read from with `id` `null`.
- **Identity.** `id` is the problem key in English camelCase. A state that can
  end and return also carries, after a colon, the period it belongs to. The
  two budget problems are `aiBudgetMissing` and
  `aiBudgetExhausted:<resetsAt>`, where `resetsAt` is the ISO 8601 reset
  instant of the exhausted window as the budget summary (gh-1456) reports it.
  The id is therefore not a UUID, and a client treats `id` as an opaque
  string. The identity of an exhausted budget is its window, not one
  exhaustion. An exhaustion can end before the reset instant and return: a
  reserved call counts at its estimate until it settles at a lower cost or
  fails, and an administrator can raise a cap that is then reached again. The
  problem keeps its id through that, so `instanceId` does not change and a
  notice the user hid stays hidden for the rest of that window. Why: a
  constant id would keep a hidden notice hidden in every later window. An id
  for each exhaustion would need a recorded start, which a derived problem
  does not have, and it would show a hidden notice again each time settling
  reservations move the spend across the cap.
- **Count and order.** A derived problem counts in `activeCount` and is listed
  before the stored problems.
- **The budget problems.** Both have category `agents` and severity
  `critical`, because the gateway refuses every model call of a tenant in
  either state. That makes them banner candidates of the summary. They have no
  stored kind, so their `impactKey` is the category's fallback,
  `agentsNotRunning`. Their `actions` are empty: the caps are set by an
  administrator, not by the tenant's user. The operator-wide caps are not
  read, so a refusal they cause shows the tenant no problem.

## Consequences

- A derived problem writes no notification, has no occurrence count and leaves
  no resolution record. The list of resolved problems that gh-1919 will add
  will not contain it.
- Nothing tells a connected client that a derived problem appeared or ended.
  gh-2023 and gh-2024 will publish a status invalidation at the first refusal
  of a window and at the reset instant. Until they land, a client sees the
  change on its next read.
- Every status read runs the budget summary: the budget row, the tenant's
  timezone and its spend, and while a window is exhausted also the reset
  instant and a second timezone lookup for the text.
- The `services` list still derives `state` and `since` from the stored
  problems, because its `since` is a problem's `first_seen_at` (gh-1561). A
  budget problem leaves the `agents` service `ok`. Showing that service as
  failed needs its own decision about `since`.
- A tenant without a budget row always lists `aiBudgetMissing`, so a test that
  reads the status for other reasons gives its tenant a budget row first.
