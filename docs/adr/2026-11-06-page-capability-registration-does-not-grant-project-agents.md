---
status: accepted
date: 2026-11-06
area: [backend]
supersedes: []
superseded-by: null
---

# Page capability registration does not grant project agents

## Context

[[2026-10-28-page-operation-family]] separates page read/write capabilities from
item capabilities to prevent implicit page-content access. Gh1615 registers
`core.page.read` and `core.page.write`, while leaving agent page policy to
gh1400/1844. Today schemaCore registers every CAPABILITY_IDS entry, and
generatePermissionManifest automatically grants active core entries to each
project agent. Merely adding the two identifiers would therefore grant page
access before that policy exists.

[[2026-11-04-owned-databases-admit-safe-module-agent-tools]] retained existing
core grants while bounding non-core module grants. This record narrows automatic
core grants for exactly these two newly registered page identifiers. It leaves
both historical ADR bodies and their other rules unchanged.

## Decision

Retain registration of all CAPABILITY_IDS entries in schemaCore. Registration
is needed by the existing human-session MCP composition; it is distinct from
generating a project's agent permission manifest.

In the existing manifest/permissionManifest.ts core-grant computation, exclude
exactly core.page.read and core.page.write from automatic project-agent grants.
Preserve every other existing core grant and the existing non-core owned-module
predicate. The two identifiers remain core identifiers, so the later non-core
module loop must not reintroduce them, even if a module declares them and its
databases belong to the project. No project receives an implicit page grant
from activation, item grants, database ownership or registration alone.

Actual AgentTool discovery and invocation continue consuming the generated
manifest. Page operations remain in the implemented operation catalog but are
absent from an ordinary project's discovered tools, and explicit invocation
with those generated grants is refused through the existing unavailable-operation
path. The already delivered page.restoreVersion now classified as page-write
follows the same rule. Do not grandfather its prior item-write grant.

Human REST/session MCP behavior and existing restricted-credential checks stay
unchanged. A direct gateway test with explicitly supplied page capabilities can
prove binding and approval behavior; it must not be reported as a real project
agent receiving those capabilities. No new grant table, flag, permission API,
grant backfill, credential grant or page-content approval policy is introduced.
Gh1400/1844 must explicitly reconcile this default when their actual policy is
implemented.

## Alternatives considered

- Remove page capabilities from schemaCore registration: rejected because it
  also removes them from the existing human-session MCP composition.
- Keep automatically granting every active core identifier: rejected because
  registration would silently widen every project agent's page access.
- Add a new explicit grant mechanism now: rejected because its persistence,
  administration and page policy belong to later issues.

## Consequences

The existing permission-manifest owner implements one bounded exclusion, without
changing transaction or data ownership. Tests use a real active registry and
generated project manifest to prove both page identifiers absent, legacy core
grants retained and module declarations unable to regrant the page identifiers.
Actual persisted-run AgentTool discovery/calls prove refusal without document
creation, edits or approval requests. Existing human-session MCP controls prove
that registration still exposes the implemented page operations there. No model
provider or deployed release is needed for these local controls.
