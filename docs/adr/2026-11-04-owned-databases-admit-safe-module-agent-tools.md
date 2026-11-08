---
status: accepted
date: 2026-11-04
area: [backend]
supersedes: []
superseded-by: null
---

# Admit safe module tools using the run project's existing database ownership

## Context

Gh-1523 composes existing module tools before gh-1810 introduces general per-database agent grants and before gh-1791 implements deferred module-tool execution. [[2026-10-28-module-agent-tools-approval-and-grants]] requires explicit classification and project grants. Current permissionManifest selects database rows by owner_project_item_id, while ModuleRegistry.getCapabilities only lists active declarations. There is no general module-capability grant store yet; project_mcp_grants belongs to MCP registrations. Treating activation as a project grant would expose every module capability to every project.

This record narrows the interim composition contract without implementing either later owner. It does not supersede the original classification, database-access or approval policy.

## Decision

### Explicit classification and bounded composition

Every module agent-tool descriptor explicitly declares approval mode none, always or unlessProjectPermitted; omission is a manifest validation error, never a safe default. An optional riskClass is validated against the existing shared RiskClass set. Mode none permits only absent, read or write risk; destructive, outbound, breaksLink and unclassified are not admitted as none. An unlessProjectPermitted declaration also names its project permission, without creating a permission writer or evaluator here.

Gh-1523 composes only tools with mode none and an admissible classification. Always and unlessProjectPermitted tools remain absent until gh-1791 supplies the actual approval owner; their handlers are not invoked, and this issue creates no moduleTool approval payload. A future implementation must reconcile its older requiresApproval-only wording with the accepted modes. Schema-valid declaration is not execution authorization. Missing/malformed handler or argument-schema exports fail closed at their existing module boundary.

Classify the existing heartbeat.list and heartbeat.history as read/none. Classify only the existing heartbeat.trigger as write/none: it invokes the existing guarded manual-fire owner for an already configured eligible heartbeat in the calling run's own project. This is a narrow exception to the original list of immediate module-write cases. It does not create or change automations, change project visibility, bypass enabled/event/running checks, or authorize another action's side effects. Downstream action and write/approval owners retain their contracts. Approval-gated heartbeat.create/update/setEnabled remain gh-1846; no outbound or destructive tool gains this exception.

### Conservative interim module-capability predicate

Keep the existing core capability computation and closed CapabilityId unchanged. PermissionManifest.grantedCapabilities may contain validated declared module capability strings; the generic AgentTool adapter explicitly intersects them with CAPABILITY_IDS before constructing its core gateway context. Never pass arbitrary module strings as core ids or change MCP credential grants in this issue.

A non-core capability declared by an active module is admitted for the run's project only when all these conditions hold:

- The module declares at least one database key.
- Every declared key resolves to a current, visible, unarchived database row in this tenant, and every such row has owner_project_item_id equal to the run's actual project item id.
- Every corresponding database is writable under the existing permission-manifest restriction; a read-only database causes this conservative predicate to fail even for a read capability.

Use the module's validated database keys and the existing database ownership rows. Do not infer access from capability names, tool arguments, a thread's project, module activation or a nonempty subset of owned databases. Missing/archived/foreign/unowned/read-only rows, a module with no databases, or an unknown capability never pass this predicate. A module with no capability on a tool still needs only active composition and safe classification, as the original ADR specifies; the heartbeat handlers separately derive their own project from the persisted run.

This grants only bounded tool visibility using the existing ownership model. It adds no table, JSON permission flag, grant-admin route, sharing, grant persistence or new data-access bypass. The manifest is computed from current project state when the session is composed; this decision makes no atomic revoke-through-handler or global snapshot claim. Existing write owners and tenant scope continue to authorize actual effects.

### Future grant owner

Gh-1810 remains the sole owner of agent_database_grants, explicit read/write/none access, transactional revoke coordination and general database visibility/enforcement. When delivered, it must replace this interim module predicate with its actual access provider, preserving absent-ungranted tools and existing core behavior. Do not maintain two competing grant stores. Gh-1791 remains the sole owner of deferred module calls; gh-1580 remains the MCP exposure owner. Their future specifications must reconcile this prerequisite rather than silently retaining unsafe activation-based grants.

## Alternatives considered

- Grant all active module capabilities: rejected because declaration is not a project grant.
- Add an independent module-capability table or arbitrary project properties: rejected because that creates a second owner beside gh-1810.
- Implement all of gh-1810 now: rejected because its storage, generic read/write guards, visibility and revoke semantics are a distinct later Task.
- Deny all module capabilities until gh-1810: safe but leaves gh-1523's positive project-specific composition criterion undelivered. Existing full database ownership provides a narrower real predicate without new state.
- Default missing classification to none, or invoke a gated tool before the deferral owner exists: rejected as privilege escalation.

## Consequences

Use the existing module registry loader/resolution owner and typed argument/result boundaries. Reuse the shared closed risk set; if necessary, declare only the workspace shared dependency in module-registry and its lockfile importer, with no new external version. No new root export is required for test-only grants or handlers.

Resolve the existing active heartbeat rule-kind map in session composition and pass it to the existing heartbeat factories. Preserve native tool-use/result events and their call ids/names; no generic/MCP identity is invented for module tools.

Tests cover real project ownership positive and missing/partial/read-only/archived/foreign/no-database negatives, ungranted absence, invalid classification and schema/handler boundaries, current heartbeat calls, safe handler errors and name collisions. Keep core capability and MCP behavior unchanged. The interim predicate is deliberately restrictive and is not proof of the future database-grant system.
