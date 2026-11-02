---
status: accepted
date: 2026-11-01
area: [backend]
supersedes: []
superseded-by: null
---

# Value-link item-update handoff covers transformed user properties

## Context

[[2026-10-29-item-pre-write-transforms-per-module-registry]] checks module ownership of transform-added system keys. Its Consequences state that the value-link handoff checks caller keys only and that a transform adding user-owned keys must account for their ownership itself. [[2026-10-29-tasks-date-and-time-rules-in-pre-write-transform]] requires a date-off write to clear the user-owned `timeFrom` and `timeTo` fields and the system-derived `time` field.

The combined gh-1516/gh-1536 contract exposes the gap: an active value link for `date` alone must not authorize the `valueLinks` process to clear additional user-owned time fields. Allowing those transform outputs without their own handoff would let one inherited property overwrite another property's user value. Checking only changed values would still exempt explicit writes of null or an equal value from the declared property-level permission rule.

This decision narrows the earlier registry ADR's caller-only handoff consequence for existing-item updates by `valueLinks`. It does not replace the registry or alter its other ownership rules. The historical ADR bodies remain unchanged.

## Decision

For `updateItemWithClient` with `systemOwnerProcess: "valueLinks"`, the required handoff keys are the union of:

- every key supplied by the caller, preserving the existing caller-key restriction;
- every `owner: "user"` key present in the final transformed properties patch.

Every required key needs its own visible `value_links` row in state `on` for the target item before the value write. This applies even when the output is null or equal to the stored value. Transform output is not additional authority from the caller. Missing, broken or tenant-invisible required handoff causes `403 owner_violation`; the value, link-state and transactional side effects must roll back together.

A system-owned key added by a registered module transform retains the registry's existing null-or-matching-module `ownerProcess` check. It is not added to the value-link handoff set merely because the transform wrote it. A Tasks date-off update therefore requires active handoff for `date`, `timeFrom` and `timeTo`, and does not require a link for transform-derived system `time`.

Successful system writes continue leaving link states unchanged. Ordinary user/agent writes still break only the links whose values actually changed. Other system writers, create behavior, relation-side authorization and read-only proposal preparation are unchanged. No link rows are created implicitly to make an unauthorized update pass.

## Consequences

- A `valueLinks` date update can be refused because its required module transformation also writes user-owned fields without active handoff. This is deliberate; a date link does not grant authority over the whole schedule.
- The production item-write boundary must account for the final transformed user-key set. A pure transform or preparation helper cannot independently establish database handoff authority.
- Real Tasks composition tests must cover missing and broken generated-key handoffs, an unchanged-null generated field without handoff, atomic refusal without events, and an all-active success that leaves links on without a derived-system-time link.
- This records authorization scope only. It does not select a new lock ordering or claim concurrent safety. The reported existing link/item lock inversion needs separate measured reproduction and an explicit concurrency decision before changing that mechanism. Static source inspection and this accepted decision do not establish implementation or batch acceptance.
