# Relay model tiers

Worker ability is `low`, `medium` or `high`, independently of provider, model,
reasoning and permission settings. The initial mapping is Haiku/Sonnet/Opus.
Reasoning must be supported by the chosen model; Haiku currently supports low.
Run snapshots keep every later step and broker turn on the admitted execution.
Changes to a worker affect new runs; a full resume makes a fresh choice.

## Workflow policy

The repository default is fixed medium. `implement-issue` reads the issue's tier;
review, fixes, recovery and follow-up triage use high. Merge reads the uniquely
linked issue, with high for a completely unlinked PR. Bad/missing metadata,
ambiguous closing references, unavailable providers and missing exact-tier
workers hold eligibility without consuming a claim attempt. Use `bb relay why`
to inspect the source, body hash, preset and reason before dispatch.

The pinned review bot checks execution fingerprints before both verdict reuse
and incremental scope. Changed/unknown identities force a full review. Every
model call uses the broker snapshot, including three independent first-review
angles; each angle gets a third of the original platform model budget. A pinned
session never falls back to native Claude. Existing severity and CI gates apply
to every tier.

## Issue audit and guarded backfill

`.github/scripts/model-tier-assessment.json` records the dated assessment and
source body SHA-256 for every open issue. It is an audit record, not runtime
configuration. Runtime routing reads the issue metadata documented in
`.github/ISSUE_FORMAT.md`. The original backlog contains 69 implementation
issues (1 low, 35 medium, 33 high), 12 epics and 3 manual tasks. The three model
routing implementation tasks add three high assessments. Epics/manual tasks and
existing valid metadata are unchanged; classification never adds ready labels.

Fetch the current open issues with `gh issue list --repo dvdtrsnk/semprec --state
open --limit 1000 --json number,title,body,labels,url,updatedAt,createdAt` into an
operator-owned snapshot. Preparation requires every source hash and complete
coverage to match. Store manifests and ledgers in a durable operator directory;
they contain original bodies for rollback and are not repository configuration.

```sh
node .github/scripts/backfill-model-tiers.mjs --prepare \
  --assessment .github/scripts/model-tier-assessment.json \
  --issues /absolute/path/open-issues.json --manifest /absolute/path/manifest.json
node .github/scripts/backfill-model-tiers.mjs --manifest /absolute/path/manifest.json
node .github/scripts/backfill-model-tiers.mjs --manifest /absolute/path/manifest.json --apply
node .github/scripts/backfill-model-tiers.mjs --manifest /absolute/path/manifest.json --rollback
```

Dry run is the default and performs no writes. Apply records intent before PATCH,
re-reads immediately beforehand and verifies afterward. Only the body is sent;
labels, state, assignees and milestones remain intact. A changed body is a conflict
and is never overwritten. GitHub offers no issue-body compare-and-swap API, so a
concurrent write between read and PATCH cannot be made atomic: stop on an
unexpected result and inspect the issue. Never retry an uncertain write blindly.
After a crash, the exact target hash permits idempotent recovery. Rollback only
restores the original body while the current body matches the recorded target;
a later manual edit is a conflict. Run one migration operator at a time.

## Deployment and pilot

Keep Semprec disabled while installing the backward-compatible Relay parser,
worker tiers, admission gate and snapshot/broker changes. Let every accepted
run and host command finish before reload; a project disable allows them to
drain. Land issue authoring/validation and metadata before dynamic workflows.
The new Relay parser must be live before the new strict YAML keys reach develop.
Pin the same reviewed bot SHA in `.relay/config.yml` and the Actions workflow.
Synchronize the local develop source before Relay creates new worktrees.

Use an isolated fixture repository to prove low/medium/high, exact allow-list
selection, held metadata errors, immutable continuation after preset changes,
and restart recovery. Start presets with maxConcurrent=1, command cap=1 and
project cap=2. Keep the broker concurrency unchanged. Then use a bounded Semprec
pilot, monitor real verify/review/fix/merge rounds, and fix failures at their
source. Do not arm proposed #1103 merely to obtain a low example. Inspect account
pool health and quotas before relying on failover; provider availability alone
does not prove quota remains. Record measured usage and unknown costs honestly.

For rollback, disable/drain first. Prefer fixed medium policies with the new
compatible plugin. Remove new YAML keys on develop before reverting the plugin
to an old strict parser; metadata may remain, because the original first-line
Blocked by header is preserved.
