# Batch 19 local continuation decision

Authority: explicit owner instruction on 2026-11-03 to decide autonomously so
Semprec development continues, and the append-only ADR
`2026-11-03-local-development-continues-with-open-production-gates`.

## Local candidate disposition

Accept source candidate `716939c6754397d9ef0d0009b1d49ffb2cac4e88`, tree
`52d62962242a95650e304f3dc06e632d05024b16`, for local integration of the four
corrective sources only. Their staged native, real PostgreSQL16 restore/replay,
source consumer, Linux hermetic, standalone E2E and static checks are recorded
in `thr_pz39tcih5r/batch-19-run/final-716939c6/STOP.json` (SHA-256
`621cc1914f9958a2456b3cc399a35f6fdd2b915f6af696fb04659afd689e9ecd`).
Parent direct delta inspection closed the remaining R2-1 ownership finding;
R1/R2 remain NOT CLEAR on their originally reviewed SHAs, with no new independent
CLEAR or additional automatic review. The separate complete E2E passed 5 files/45.

The actual unchanged full `pnpm run verify` remains FAIL, exit 1, PID66560,
log SHA-256 `19d8d9ed4c47f77c1c0dd73defcc112160890e85988a197e43b2f4e95c50084e`.
Its integration tier passed 6472 and failed 4 tests; its E2E was NOT RUN. Grant
ONLY this candidate's local integration exception for these exact failures:

- mailDraftsStore populated legacy upgrade exceeded30000ms.
- mailThreadAliases populated legacy upgrade exceeded30000ms.
- mailThreadBackfillCli compiled migration scenario: DROP statement timeout and
  individual database absence not established. Its primary and cleanup report
  entries represent one failed test, not two.
- mcpConnectionFactory inherited-name assertion received the extra environment
  name `__CF_USER_TEXT_ENCODING`.

These exceptions are evidence-based local dispositions, not root-cause, flake,
production safety or future-candidate claims. Preserve all original failures.
The parent observed one subsequent three-file campaign passing 21/21 with a
verified initial observer barrier and final inventory, four individual current
scratch database absence transitions, joined children and unchanged source.
One active DROP waited for CheckpointDone without a blocker in that sample;
250ms polling and a later passing run do not prove the original timeout cause
or retroactively prove its missing DROP outcome. Audit SHA-256
`d4df2a82cb419cac7fef925d770812f5b6883e3830a22f893dd267f21c4484e3`.
Original failed observer supervision, original integration wrapper98 and Linux
missing-tool failures remain recorded with their subsequent narrow dispositions.

## Completion and advancement scope

Update and approve the aggregate's exact LOCAL gate contract. After normal local
no-ff integration, use the existing guarded completion for the four corrective
issues and the aggregate ONLY. Preserve all current source bodies/approvals and
immutable handovers. Record exact graph, paths, original and metadata candidate
SHAs and unchanged runtime bytes; do not rerun runtime after metadata-only edits.
Gh-1086 is NOT eligible for completion. It stays OPEN with unchanged requirements,
including strict releases, deployed isolation/catalog/config/log evidence,
real backup/restore rehearsal, disclosure and a recorded security decision.
These remain BLOCKED/NOT RUN, not waived. This local acceptance authorizes neither
production exposure nor a deployment/invitation.

Batch20 and later local code work may proceed after the local batch19 handover.
For gh-1087 preserve all invitation functional criteria while replacing the
local gh-1086 predecessor with the four corrective sources; its Context retains
gh-1086 as an unsatisfied production/release dependency. Reconcile recovered
migration0123 instead of adding a duplicate or claiming fictional strict-release
provenance. This is scope reconciliation, not permission to activate a real
second tenant. No issue, requirement, routing or held-client scope is deleted.

The parent owns local acceptance, exact spec approval, archival and successor
dispatch. No more batch19 test or review campaigns are authorized. Any remaining
full-load fixture reliability or production evidence is tracked explicitly;
unrelated local development proceeds under the owner-directed contract.
