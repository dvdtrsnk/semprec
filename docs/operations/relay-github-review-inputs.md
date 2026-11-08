# Scoped GitHub review inputs

Semprec's `fix-review-findings` and `recover-blocked-issue` workflows start with
`github-review-inputs`. Relay obtains the source issue, the open PR and complete
summary/inline review comments through Access Hub before starting the repair
agent. The explicit grant is `semprec-relay-github-review`, restricted to
`dvdtrsnk/semprec` and assigned to Semprec's approved repository binding.

Access Hub trusts only Relay's verified plugin caller and database-backed run
identity. It rechecks current grants and project sources on every read and checks
the PR's repository, branches and HEAD before and after collecting comments.
Capture can run before an agent thread exists. It fails closed on denied access,
changed identity, invalid output or incomplete/oversized comment collections.

The step exposes `steps.capture-review.path` and `steps.capture-review.sha256`.
Agents verify the whole-file SHA-256 before reading the immutable
`relay.github-review-inputs/v1` file. It contains the original issue and PR
bodies plus summary and inline comments; a bot's findings may exist only in a
summary. The capture limit is 256,000 UTF-8 bytes and ten pages of 100 comments
per collection. Files remain content-addressed audit inputs outside the repo.

Agents use `access_hub_context`, `access_hub_schema` and `access_hub_call` for
additional GitHub reads and review responses. `issue_get` reads one issue;
`issue_closed_by_reviews_list` returns the authoritative merged closing PRs for
a blocker; `review_get` reads each closing PR's body. Summary replies use
`review_summary_reply`; inline replies use `review_comment_reply`. Thread
resolution uses `review_threads_list` and `review_thread_resolve`, with the
current remote PR HEAD supplied as `expectedSha`. These writes require their
own grant; prompt instructions never grant access. A denied operation is
reported, without another account, raw CLI or global authentication fallback.

Relay retains ownership of verification, push, review and merge. Backend and web
verification gates remain unchanged. GitLab's separate `relayGitLab` service,
`relay.gitlab-snapshot/v1` format and Jsme Tu delivery grant are unaffected.

After deploying the compatible Hub and Relay code and merging these workflows
into `develop`, recover a parked PR through a new run at the current workflow
revision. Preserve the failed run as history. Before reloading Relay, ensure no
project has an active host command job; a plugin reload terminates those jobs.
A successful repair run is not a completed issue: verify the subsequent review,
required checks, merge and issue closure.
