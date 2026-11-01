# Batch 08 specification reconciliation

Authority: owner-delegated parent controller `thr_pz39tcih5r`, under
`2026-10-31-owner-delegated-backend-program-supervision`. This approves an exact
requirement correction before acceptance; it records no successful test result
and completes no issue. Original implementation handovers remain unchanged.

## Generic localized problem notification titles

Gh-1466 Task 4 requested a title parameter for a problem title. The current
`RaiseProblemInput` and `semp_problems` table have no title field. Gh-1459
separately assigns problem text rendering to a later read model. The actual
notification catalogs already define a generic `notification.semp_problem.title`
for both supported locales, without a placeholder; `writeNotification` resolves
that entry using the receiving user's locale. Its interpolation support alone
does not provide a truthful problem title. The original gh-1466 handover admits
the omitted parameter and is provenance, not compliance evidence.

Use the generic localized entry for this batch, with no problem-specific title
parameter. Do not invent a title from internal kind keys, source identifiers or
provider/error text, and do not add a title field or alter producer inputs.
Problem-specific push titles would require a separately specified source,
ownership, localization and content contract; this decision grants none.
The detailed read model remains outside this change.

Correct gh-1466 Context, Tasks 4 and 5, scope and acceptance criteria, propagate
its complete embedded snapshot and specification hashes to batch 08, and
reapprove those exact records under the existing delegation. Keep severity,
transition identity, notification deduplication, user preferences, delivery and
suppression of source-kind pushes unchanged. No historical accepted ADR is
edited, no new persistence or lifecycle mechanism is introduced, and no other
member requirement is waived.

Acceptance requires actual production `raiseProblem` and fan-out evidence for
both `cs` and `en`: the stored notification title and outbound push title equal
the respective generic catalog entry, without unresolved placeholders or
internal/provider content substituted into that title. Use the existing scoped
`sempProblemNotification.test.ts` production-path fixture and owned fake senders;
no live provider call or client work is needed. Existing tests and source
inspection alone have not yet established these acceptance results.
