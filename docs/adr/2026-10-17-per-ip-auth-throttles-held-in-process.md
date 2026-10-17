---
status: accepted
date: 2026-10-17
area: [backend]
supersedes: []
superseded-by: null
---

# Per-address throttles on the public auth routes are held in process memory

## Context

Login, password-reset request, password-reset consume and (from #1087) invitation acceptance are
reachable without a session. The database-backed login lockout counts failures per *(email, address)*
pair, so one address that tries many emails (credential stuffing) is never stopped, and the
reset-consume route has no throttle at all. The lockout's failure rows are written outside the
failing operation so that they survive it
([[2026-09-27-auto-committed-writes-for-records-that-must-survive-a-failure]]). Production runs exactly
one semprec-api process (`deploy/systemd/semprec-api.service`).

## Decision

- **In-memory sliding window.** `createClientIpThrottle` (`clientIpThrottle.ts` in semprec-api) keeps,
  per `(action, key)`, the timestamps of the counted events inside the action's window and refuses
  further attempts with `429`, `code: "rate_limited"` and a `Retry-After` once `maxEvents` are held.
  At most `maxKeys` keys are held; when full, keys whose events all expired go first, then the key
  recorded least recently.
- **Single-process assumption.** The limiter sees every request only because there is one process.
  A restart clears every window. Running a second semprec-api process would give each its own budget
  and requires revisiting this decision.
- **Address grouping.** An IPv4 address is its own key, an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`)
  uses its IPv4 address, and any other IPv6 address uses its `/64` prefix, because one host commonly
  holds a whole `/64` and would otherwise get a fresh budget per address.
- **The lockout keeps its role.** The *(email, address)* lockout stays database-backed: it protects a
  specific account and its rows are the audit trail written per
  [[2026-09-27-auto-committed-writes-for-records-that-must-survive-a-failure]]. The per-address
  throttle is an additional, coarser bound and replaces neither it nor the per-account reset cap.

## Alternatives considered

- **A Postgres table plus a retention sweep.** Rejected: these rows exist before authentication, are
  worthless after an hour, and would add a write per hostile request plus a sweep job to bound the
  table, for a property (surviving a restart) that is not needed — an attacker gains one window of
  attempts per restart of a process they cannot trigger.

## Consequences

- Hostile traffic costs memory bounded by `maxKeys`, not database writes.
- Behind a shared NAT or a single trusted-proxy address, legitimate users share one budget; the
  limits are sized for that.
- The addresses come from `clientIpFromRequest`, so the throttle is only as trustworthy as the
  `TRUST_PROXY` configuration.
