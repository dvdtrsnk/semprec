---
status: accepted
date: 2026-11-03
area: [cross-cutting]
supersedes: []
superseded-by: null
---

# Continue local backend implementation while production evidence stays gated

## Context

The owner explicitly instructed the parent controller on 2026-11-03 to resolve
project decisions autonomously so development continues, in accordance with
Semprec's architecture. The local backend delivery program cannot produce two
historical production strict releases, live backup/disclosure evidence or a
production security sign-off by repeating local tests.

This is a scoped exception to the local sequencing/completion provisions of
[[2026-10-31-sequential-backend-delivery-batches]] and
[[2026-10-31-owner-delegated-backend-program-supervision]], not a relaxation of
[[2026-10-03-tenant-isolation-through-row-level-security]]. Their accepted bodies
remain historical records. Batch 19's local security repairs have technical
and independent-review evidence; the production checklist in gh-1086 remains
unperformed. A failed full verify also remains a failed result.

## Decision

Separate local implementation acceptance from production/release authorization.
The parent may resolve scope conflicts, record bounded evidence-based local
exceptions, integrate reviewed corrective work, and advance the single-writer
backend sequence without repeatedly asking the owner technical questions.
Actual tenant/privacy defects and data-loss risks must still be repaired or
explicitly adjudicated before affected work proceeds; unavailable external
evidence is never converted into a PASS.

For batch19, preserve all five source snapshots and their unique routing. Accept
and complete only its four local corrective sources and its local delivery
aggregate after parent adjudication. Leave gh-1086 OPEN with its original Task,
AC, approval, parent and dependencies unchanged. Its production checklist is a
release gate, not a local implementation predecessor. The aggregate handover
and acceptance receipt must name this incomplete source explicitly; neither the
aggregate completion nor later batch completion implies gh-1086 completion.
The manifest retains gh-1086 assigned to batch19 for accountability. No issue
store/completion or structural-validator code changes are needed or permitted
by this decision. Later code requirements may replace gh-1086 as a local
predecessor with the four completed local corrective sources while retaining
an explicit production dependency in their Context and release documentation.

Record each local verify exception with the exact tested candidate, original
failure/log, supplemental evidence, uncertainty and limits. No automatic future
waiver, timeout increase, environment workaround, false full-verify PASS, or
security clearance follows. Metadata-only policy/completion commits may reuse
ancestor runtime evidence only after byte comparison proves executable/test/
configuration inputs unchanged, explicitly recording both SHAs. A new source
change requires the checks justified by that change. Review remains bounded to
one complete audit and one same-reviewer focused recheck, followed by parent
direct disposition; this decision creates no further review round.

Keep the single working tree, one writer, local integration branch, guarded
issue approval/completion and original handover preservation. Continue main
batches through 74; the two held client batches remain excluded. A missing
production credential or environment does not block unrelated authorized local
implementation. No push, deploy, production access, live invitation/second-
account activation, provider call, web/mobile work or release is authorized.
Before any such production operation, gh-1086 and the relevant operational
prerequisites must actually be satisfied and separately authorized.

## Consequences

Batch 19 can close its local implementation lane while gh-1086 remains visibly
open. Progress reports must distinguish completed local batches, remaining
source requirements and release readiness. Production safety is not inferred
from a local acceptance count. The parent keeps evidence and follow-ups for
historical full-load fixture cleanup and failed verification rather than
repeating diagnostic loops or hiding those results.
