---
status: accepted
date: 2026-09-26
area: [cross-cutting]
supersedes: []
superseded-by: null
---

# Merged review findings become proposed follow-up issues

## Context

The code-review bot keeps a review memory on every pull request it reviews,
and each finding in it carries a status. That memory is frozen at the last
review before merge: a finding still `open` at that moment stays `open`
forever, whether or not a later pull request fixed it. `open` is therefore
often stale. Measured on 2026-09-25: 138 open findings across 171
memory-bearing pull requests, and all 6 `high` findings on pull requests above
#266 were already fixed on `develop`.

Leaving those findings alone loses the real defects among them; treating them
all as work wastes effort on the ones already handled. #265 did this audit
once by hand and found 10 of its 39 findings already handled — useful, but a
one-off, and nothing repeats it.

The only scheduled repository automation today is
`.github/workflows/close-completed-epics.yml`. Its header comment explains why
it is a GitHub Action and not a Relay workflow: Relay workflows trigger on a
label on an open issue or pull request and have no schedule, and Relay's tick
only runs for an enabled project, so a sweep hosted there would stop exactly
when the project is paused. That reasoning was never recorded as a decision,
and nothing under `docs/adr/` covers a repository automation that creates
issues on its own, keeps its state in GitHub labels and markers, or writes to
GitHub as the Relay App.

## Decision

Open findings of merged pull requests are turned into proposed follow-up
issues by a two-stage pipeline:

1. **Deterministic harvest, AI triage.** A scheduled GitHub Action harvests
   the open findings of merged pull requests deterministically — no AI — into
   a harvest issue. A Relay workflow triggered by that issue's
   `followups:ready` label verifies each finding against `develop`, decomposes
   the valid ones into issues and audits them.
2. **Every created issue is a proposal.** Each issue the pipeline creates is
   labelled `spec:proposed` and is never dispatched until a human swaps that
   label for `spec:approved` + `agent:ready` — repository rule 7, agent-
   originated changes are proposals
   ([[2026-09-10-agent-writes-are-proposals-not-direct-writes]]).
3. **All state lives in GitHub.** The labels `followups:harvested`,
   `followups:harvest`, `followups:ready`, `followups:issue` and
   `spec:proposed`, plus HTML markers in issue bodies and comments, are the
   whole state. There is no watermark — merges land out of order and a
   failed run would silently skip past findings — and no database.
4. **Backpressure and bounds.** A harvest starts only when no harvest issue is
   open and no follow-up issue awaits approval, and takes at most 30
   findings. A fixed floor, `HARVEST_MIN_PR = 266` (the first pull request
   after #265's audit), bounds the backlog.
5. **One deterministic skip.** The only finding skipped without the AI verify
   step is a resolved inline thread carrying the bot's own exact `Fixed.`
   reply. Everything else — other resolved threads, paths that no longer
   exist — goes to the verify step with those facts attached.
6. **Writes as the Relay App, through the proxy.** The Relay workflow writes
   to GitHub as the Relay App through Relay's loopback token proxy, opted into
   per command step, so the real token never enters a job. Agent steps get no
   GitHub access.
7. **Zero-dependency scripts, one code path.** The deterministic parts will be
   zero-dependency ES modules under `.github/scripts/review-followups/`,
   tested with `node:test`. That directory does not exist yet: this ADR
   records the decision ahead of the implementation, which lands in later
   pull requests. The scripts call the REST and GraphQL APIs with `fetch`
   through `GITHUB_API_URL`, `GITHUB_GRAPHQL_URL` and `GITHUB_TOKEN`, so the
   same code runs in GitHub Actions and behind the Relay proxy.

## Consequences

- Closing a proposed follow-up issue retires its findings permanently — the
  harvest never picks them up again. Reopening the issue is the undo. Closing
  an epic decides nothing about its children; each child issue is retired or
  kept on its own.
- Because of the backpressure rule, a triage that is parked — a harvest issue
  left open, or a follow-up issue left awaiting approval — holds back every
  later harvest until a human resolves it.
- The Relay stage depends on a Relay plugin feature, the per-step loopback
  token proxy (dvdtrsnk/bb-plugin-relay#57); until it ships, the Relay
  workflow cannot write to GitHub.
- Alternatives rejected:
  - **A merged-at watermark** — out-of-order merges and a failed run would
    silently skip findings; labels and markers per pull request do not.
  - **Periodic manual audits like #265** — they work once and then do not
    repeat.
  - **Arming follow-up issues automatically** (`agent:ready` on creation) —
    violates rule 7; an AI-verified finding is still a proposal.
  - **Triage inside GitHub Actions** — would put a model call and its
    credentials into Actions; Relay already hosts agent steps.
  - **`gh` acting as whatever account the Relay host is logged into** —
    writes would be attributed to a personal account and the token would be
    exposed to the job; the Relay App through the proxy avoids both.
