---
status: accepted
date: 2026-11-03
area: [backend]
supersedes: []
superseded-by: null
---

# Approval notification undo copy follows application capability

## Context

The gh-1773 body helper embeds an undo sentence in each action template and receives only the description. gh-1683 requires independently addressable description templates with their declared parameters. gh-1730 defines generic operation reversibility and separate risk classes. A risk class such as write, outbound or breaksLink does not establish an undo implementation for an external MCP tool.

This extends [[2026-09-10-english-canonical-keys-with-i18n-labels]] for the existing write-time approval notification body. It does not change approval risk, execution, ownership or push delivery policy.

## Decision

The helper receives the created request snapshot, including its validated payload/description and risk class. For a recognized generic operation, use the existing OPERATION_METADATA reversible flag. An external MCP request has no Semprec undo implementation and gets false for this application-undo capability regardless of its risk class. Do not derive reversible from riskLevel=write or infer an external tool's undo from its name, argument values or model output.

Provide all six approval.* description keys in both backend notification catalogs with the declared gh-1683 parameter contract, as action text without embedded undo claims. Preserve the existing additional page-restore description contract. Body action entries may reference that text, but must not leave these exact six keys absent or silently discard required impact parameters. Optional projectName may be absent; do not invent it.

Store two separate catalog sentences for application undo availability. Keep the undo sentence "This can be undone later." The false sentence is "Semp cannot undo this action." with its Czech translation. This replaces the stronger phrase "This action is irreversible.": lack of an application undo does not prove that a provider or a human can never reverse an external effect. The fixed approval title remains unchanged.

The producer supplies a body action key/params and the selected suffix key from the request snapshot. Extend the existing notification writer only with the optional bodySuffixKey needed to render this suffix in the same recipient locale and write transaction as the action. A suffix without an action is invalid. Interpolate the action once from the trusted snapshot parameters, then append the selected separately rendered sentence; do not recursively interpret substituted text as a template. Unknown description keys still fail rather than storing a false body, and no description means no body. Do not expose or interpolate MCP argument values.

## Consequences

Both producers, direct catalog/helper tests, notification storage and existing push serialization must agree. Cover reversible/irreversible generic metadata and MCP classes without promising external undo, exact Czech/English parameters and privacy, old NULL bodies and unrelated notification kinds. No request schema column, generic risk behavior, client work or external provider call is added.
