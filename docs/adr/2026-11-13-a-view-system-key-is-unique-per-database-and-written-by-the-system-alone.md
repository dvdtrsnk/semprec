---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# A view's system key is unique per database, read-only for every actor, and written by the system alone

## Context

Clients need to find a system view without relying on its display name, which a person may read in any language and
which may change. The Tasks Today view (issue #1798) is the first one: the overview badge and the Today list both read
it. A view row has no key column, and `createView` refuses `ownerModuleId` for a built-in view type, so a stable key
has to live in `views.config`. Until then a system view was protected only against agents (`assertViewWritable`,
[[2026-09-10-agent-identity-verified-against-projects-items]]); a human could rename or delete it. Views are direct
writes of every actor, outside the proposal flow ([[2026-09-10-views-are-excluded-from-the-agent-proposal-flow]]).

## Decision

**The key is `config.systemKey`**, an optional non-empty string of the shared `viewConfigSchema`. A view has the key
when its config has the member; presence is the test, as in `assertViewWritable`, not the value.

**It is unique per database.** The partial unique index `views_database_system_key_uq` on
`(database_id, (config->>'systemKey')) WHERE config ? 'systemKey'` allows one view per key in a database. The index
needs no `tenant_id`: the database id is server-generated and belongs to one tenant through the composite foreign key.
A second view with the key is a `ConflictError` on `config.systemKey` from `viewsStore.createView` and
`viewsStore.patchView`.

**A view that has the key is read-only for every actor.** `assertViewWritable` refuses patch, delete and `view_items`
writes on it for a human, a system actor and an agent alike, as 403 `owner_violation` with the reason `system_owned`.
This narrows the earlier rule that only an agent write is ownership-checked on a view. Other views keep the agent
rules unchanged.

**Only the system writes the key.** The choke-point entry points `createView` and `patchView` (`viewOps.ts`) call
`assertSystemKeyWritable`: a config that has `systemKey` is refused with 403 `owner_violation`, reason
`system_key_reserved`, unless the actor is `system`. The generic application service maps every caller to `user` or
`ai_agent`, so a client cannot set the key. The seed and the per-tenant cutover create their system views through
`viewsStore.createView` with `createdBy: "system"`, which does not run this check. The cutover takes the tenant's seed
lock, looks for an existing view with the key and creates the view only when none exists.

## Why

- A key set by a client would make the view read-only for everyone, including its creator, with no way back, because
  removing the key is itself a refused write. The agent case is worse: an agent could create a view the human owner
  cannot delete.
- A key set by a client ahead of a seed or cutover would take the `(database_id, systemKey)` slot, so the real system
  view could not be created, or the cutover's existence check would accept a client-made view as the system view.
- Refusing the human as well gives clients one view they can trust to be the server's, so Web and iOS read the Today
  list from it instead of rebuilding the rule.

## Consequences

- Another system view adopts the key by a later issue: it picks a constant key, creates the view with
  `createdBy: "system"` through the seed and a cutover, and needs no change to the guards.
- A system view cannot be edited through the API at all. Changing its definition is a cutover that writes the row
  directly, not a patch.
- Protection of other system views (those without a key) is not part of this decision.
