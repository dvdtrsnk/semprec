---
status: accepted
date: 2026-10-29
area: [backend]
supersedes: []
superseded-by: null
---

# Calendars are not shared between tenants

## Context

Two ways for a calendar entry to reach another person need nothing between tenants. An email
invitation arrives as mail and is answered by the invitation feature (iMIP). A calendar subscription
by ICS link reads an external feed into the tenant. A third idea, sharing a calendar with another
Semprec user so that the other user's app shows the events, does cross tenants, and the accepted
decisions exclude it:

- [[2026-10-03-tenant-isolation-through-row-level-security]] makes a tenant the complete environment
  of exactly one user, "with no sharing between users now or planned". Memberships are excluded, and
  migration `0082_drop_legacy_global_unique_keys.sql` dropped the `resource_grants` table.
- [[2026-10-07-cross-tenant-router-functions]] maps an external identifier to its tenant, and answers
  cross-tenant aggregates, through router-owned `SECURITY DEFINER` functions that return ids or numbers,
  never content. Other cross-tenant system work runs inside each tenant in turn, as
  `backend/review-rules/rules.md` requires.
- `backend/review-rules/rules.md` rates a query that reads rows of more than one tenant, or a policy
  that widens visibility, as critical.

Only #1087 made a second tenant possible. Migration `0123_drop_single_tenant_guard.sql` dropped the
single-tenant guard, and `acceptInvitation` (`backend/packages/data/src/tenancy/acceptInvitation.ts`)
is the only production code that creates a tenant for an account. Each accepted invitation gets its
own new tenant in `provisioning`. The first account is different: `bootstrapFirstAccount`
(`backend/packages/data/src/auth/authActions.ts`) binds the first admin to the sole existing tenant,
the row that migration `0056_tenants.sql` inserts, and it refuses to run once any user exists.

Any sharing feature therefore needs a decision first. This ADR records that decision, so that no
feature is built on an assumption the architecture forbids.

## Decision

Calendars and events are private to their tenant. In this version there is no cross-tenant calendar
sharing. No calendar, event or invitation of one tenant is read or written from another tenant, and
no feature shows a "shared with" subtitle on a calendar or a shared-calendar notice.

People get meetings from a calendar through email invitations (iMIP, answered by the invitation
feature). They follow external calendars through ICS subscriptions. Both stay inside one tenant. The
`sharedCalendarNotice` kind planned for the invitations database in #1901 has no producer.

## Alternatives rejected

**Mirroring events into the recipient's tenant (variant A)** is rejected for now. It is not a small
change:

- It contradicts the "no sharing between users" statement of
  [[2026-10-03-tenant-isolation-through-row-level-security]], so it would need a new ADR that
  supersedes that part.
- Event content would have to travel from the owner's tenant to the recipient's tenant through a
  channel that [[2026-10-07-cross-tenant-router-functions]] does not provide. Under row-level
  security and router functions that return only ids, no row of one tenant can be read from another.
  The channel could be, for example, a global outbox table whose content is sealed under a per-tenant
  key as in [[2026-10-05-per-tenant-envelope-encryption]], which extends the router-functions ADR. A
  global table holds no user content under `backend/review-rules/rules.md`, so that rule would have to
  change as well.
- A copy would be owned by the system and written into the recipient's tenant by a job that runs in
  that tenant.
- The design would have to decide the read and write rights on the copy, what the recipient sees of
  the private fields (description, attachments, recordings), and what happens to the copy when the
  sharing is removed.

## Consequences

- Calendar data does not cross tenants. The review rule on queries that read rows of more than one
  tenant applies to any later calendar code.
- The following are not built and not planned. Each waits for a new ADR that supersedes the relevant
  part of [[2026-10-03-tenant-isolation-through-row-level-security]]:
  - linking a People entry to a Semprec user;
  - sharing a calendar with a grantee;
  - mirroring events into another tenant (variant A above);
  - notifying a grantee.
- The invitations database (#1901) and ICS subscriptions stay inside one tenant.
- No existing ADR is changed. This ADR supersedes nothing; it records the consequence that
  [[2026-10-03-tenant-isolation-through-row-level-security]] already states.
