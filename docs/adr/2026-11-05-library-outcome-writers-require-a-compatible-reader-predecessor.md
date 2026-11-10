---
status: accepted
date: 2026-11-05
area: [backend, cross-cutting]
supersedes: []
superseded-by: null
---

# Library outcome writers require a compatible reader predecessor

## Context

The existing codec rejects notFound and the new sourceUnavailable, rateLimited
and invalidResponse error codes. error_code already exists from migration0092.
Widening a CHECK or adding a lexical exemption does not change an immutable old
binary. This applies [[2026-09-10-expand-contract-forward-only-migrations]] and
[[2026-09-24-rollback-one-release-back-with-checked-migrations]] to stored values,
without changing those accepted bodies or deploy.sh.

## Decision

Use two distinct immutable releases: a reader/privacy bridge B, then outcome
writer W. Before adding new outcome writers, make a coherent source checkpoint
whose codec accepts the finite old plus new statuses/codes, still selecting the
old columns and emitting no new stored outcome literals. Include the narrow
fixed-error/no-exception-text job failure boundary in B so rollback does not
restore sensitive diagnostic writes. Preserve safe primary/secondary failure
semantics; raw external exceptions/causes must not reach the queue logger.
The old retry/product behavior after rollback is not the new feature behavior.

W retains B and adds source, the widened status CHECK, new writers/sweep and
mapping. Reuse error_code rather than adding it again; existing rows retain
values. The supported immediate predecessor of W must actually be built,
installed, activated and version-verified B, not an unbridged release or an
amended immutable release. A bridge commit inside the first deployed W artifact
alone does not meet this requirement. No runtime flag, data rewrite, down
migration, relaxed unknown-value validation or deploy-script change is added.

For local evidence retain B's exact built reader module/dependency identities at
its checkpoint and execute that reader against representative rows produced by
W, including notFound and all three error codes, and old rows after migration.
Use an isolated local artifact, not a hand-written imitation of the mapper.
One targeted data build to capture this explicit compatibility artifact is
justified; it is not a duplicate full pre-pass. Label this a new local bridge,
not a previously deployed release or historical-binary proof.

## Consequences

The original unbridged strict reader is not compatible with new values. Source
and handover criteria must state that boundary rather than claim a lexical
checker fixes it. Actual immutable release ordering, all-process B activation
and real production rollback remain NOT RUN and gated by gh1086 and deployment
authorization. Local implementation may proceed under the local-development ADR;
it grants no permission to deploy either release. A codec-only bridge was
rejected because it would restore the previous exception-text persistence path.
