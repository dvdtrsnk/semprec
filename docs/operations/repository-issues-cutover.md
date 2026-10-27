# Repository issue cutover

## Current state

The full all-state export is committed under `issues/`: 1,375 issues (734 open,
641 closed), 1,308 comments, 17,493 timeline events, 1,193 native child relationships
and 544 handovers from verified merged closing PRs. No external attachments were
found. `issues/migration/manifest.json` preserves original file checksums and
historical specification diagnostics; `verification.json` records coverage and
final reconciliation. Every issue's update time and comment count matched the
source on reconciliation, and the terminal listing page had no new issues.

The catalog preserves 473 historical specification diagnostics (470 missing model
tiers and three malformed Touches sections). Validation exempts only an unchanged
imported record with the same recorded diagnostic. It does not approve, rewrite or
queue that work. The imported backlog contains no `agent:ready` queue intent.

ADRs retain permanent central paths. `node .github/scripts/adr.mjs --platform
<platform>` selects platform candidates including shared and historical mobile
scope; decisions remain append-only.

## Consumer rollout

- Relay's registered source is on `feat/repository-markdown-issues`; runtime adapter
  commit `f5d95655ad571b551fa82aae0d87f9fdfb345ce1` is deployed. It retains the
  existing account-pool and workspace recovery fixes. Both projects remain disabled,
  and the pre-reload run list was an empty JSON array.
- The review bot change is committed locally on `feat/repository-issue-source` as
  `eeb88558a9b6d65b0fc06e624c69c32d2794e6df`, based on the current repository pin
  `06b0e1b23ee886191bd8ade8ac61118cce3cbb86`. Its 103 targeted tests pass.
- The review bot commit is not published. Access Hub rejected cross-repository Git
  delivery from the Semprec context (`TARGET_DENIED`: branch delivery must target
  the approved source repository). No alternate account or direct GitHub transport
  was used. Its approved source revision was recovered from Relay's local checkout.
- Repository workflow changes prepare local issue completion, follow-up publication
  and scheduled maintenance through reviewed PRs. The whole workflow catalog parses
  and compiles against the deployed Relay implementation.

**Authority remains `github` until the review dependency is available to CI.**
Local files are already readable without a service credential. Do not claim the
runtime cutover is complete or enable dispatch from this preparation state.

## Final activation

1. Publish the prepared review bot branch through a repository-authorized Access Hub
   operation. Keep the change on a reviewable branch; publication does not authorize
   merging that PR.
2. Pin its immutable published commit in `.relay/config.yml` and
   `.github/workflows/code-review.yml` together.
3. Reconcile GitHub source changes again immediately before cutover. The current
   export is a snapshot, not a continuing synchronization service. Preserve new
   comments/events and original provenance; do not overwrite edited local records.
4. Verify `issues.mjs validate`, the script tests, the complete workflow catalog and
   representative local reads. Seal the final report, then set migration authority
   to `repository` in the reviewed cutover commit. Never fall back to GitHub Issues
   afterward. PR, review and CI service operations remain available.
5. Enable Semprec dispatch only when the cutover has reached its canonical base and
   all local consumers are in place. Preserve the operator's current pause otherwise.

## Validation evidence

Repository script tests: 637 passed. Targeted Relay source and routing tests:
83 passed; typecheck and plugin build passed. The wider Relay run passed 1,613
checks, skipped ten and failed two existing Linux-only secure artifact tests on
macOS. Targeted review bot tests against the current pin: 103 passed. Its wider
shell suite is not verified on this host's system Bash 3.2, which rejects associative
arrays. These limitations are not recorded as successful checks.

No mobile source or product application behavior changed. Earlier backend/web
verification results remain in the task logs; unrelated environment failures were
not repaired as part of this migration.
