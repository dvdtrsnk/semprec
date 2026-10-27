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
- The review bot commit `eeb88558a9b6d65b0fc06e624c69c32d2794e6df` is published
  on `feat/repository-issue-source` and pinned in both consumer configurations.
  [Review bot PR #35](https://github.com/dvdtrsnk/code-review-bot/pull/35) remains
  open and unmerged, as requested. Its 103 targeted tests pass.
- Publication used the same dvdtrsnk account and a one-time grant restricted to the
  exact approved dependency binding, branch and commit SHA. The grant was deleted
  immediately afterward, and the original strict Hub source confinement restored.
- All six repository workflow definitions compile. Completion metadata is checked
  on every implementation PR revision, including fix/rebase rounds. Scheduled
  maintenance and follow-up publication write local records through reviewed PRs.

The cutover commit declares **repository authority**. Local readers must not fall
back to GitHub Issues. The final reconciliation at 2026-10-27T15:37:04Z found no
source changes across all 1,375 issues, and all 6,580 imported files passed their
checksums. PR, review and CI operations remain on GitHub.

## Deployment boundary

The source cutover is complete in this feature branch. Live Relay follows the
canonical `develop` tree; it takes up the new authority when the reviewed cutover
reaches that branch. Both projects remain paused, and this change does not enable
dispatch or merge the review bot PR. Preserve that operator pause until explicitly
resumed. New specification approval remains a human decision.

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
