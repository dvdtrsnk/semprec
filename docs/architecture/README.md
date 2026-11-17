# Architecture

The current architecture of the Semprec backend and the rules that span the whole repository.
Each document states the rules as they hold in the code today. They are normative: code that
contradicts them is a defect, or the document is updated in the same pull request that changes the rule.

| Document | Covers |
| --- | --- |
| [data-model-and-writes.md](data-model-and-writes.md) | Choke point, domain modules and hooks, one owner one writer, typed rows, items, relations, value links, pages and blocks, views, trash/restore/purge. |
| [transactions-and-side-effects.md](transactions-and-side-effects.md) | `withTransaction`, savepoints, side effects after commit, bracketing non-transactional calls, lock order, advisory locks, idempotency, queue lanes, exactly-once execution. |
| [tenancy-and-security.md](tenancy-and-security.md) | Row-level security, database roles, tenant scope, secrets and encryption, sessions and auth, admin plane, tenant export/purge/restore. |
| [edges-io-and-errors.md](edges-io-and-errors.md) | HTTP contract and routes, realtime socket, outbound requests and SSRF policy, caps and timeouts, shutdown, logging, validation at the boundary, error handling. |
| [agents-approvals-and-ai.md](agents-approvals-and-ai.md) | Agent identity and grants, proposals and approvals, MCP and module agent tools, sensitive data and redaction, AI gateway and budgets, Semp chat, voice. |
| [domain-mail-and-inbox.md](domain-mail-and-inbox.md) | Mailboxes and provider connections, sync, threads, drafts and sending, Inbox capture, tick and proposal cards. |
| [domain-calendar-tasks-and-media.md](domain-calendar-tasks-and-media.md) | Calendars, Events, recurrence, timeline, Tasks, Journal, Sleep, transcription and speakers, Library, blobs and uploads. |
| [testing.md](testing.md) | Testing policy, backend test tiers, tenant isolation harness, fixtures. |
| [migrations-and-seeding.md](migrations-and-seeding.md) | Baseline schema before the first production release, forward-only expand/contract after it, migration runner, seeding. |
| [delivery-and-operations.md](delivery-and-operations.md) | No speculative generality, repository layout, branches, releases, deploy, rollback, host security, issues, Relay, review, delivery program. |

Mobile and web decisions remain ADRs in [`docs/adr/`](../adr/README.md). Operator procedures live in
[`docs/operations/`](../operations/).

## Changing a rule

- A change that alters an architectural rule updates the relevant document here, in place, in the
  same pull request. The document describes the result, not the change: no history, no issue
  numbers, no dates.
- A new document, or a new file under `docs/adr/`, is warranted only for a genuinely new
  cross-cutting decision that fits none of the documents above. A local pattern (one module, one
  operation, one lock order) is not an architectural decision; it lives in the code, with a short
  comment only when the reason is not obvious.
- Keep each document concise. Remove a rule when the code stops following it.

## Former ADRs

The backend and cross-cutting ADRs were consolidated into these documents and removed from
`docs/adr/` (git history keeps them). The table maps each former file to the section that now
holds its rule; *dropped* means the decision no longer applies (historical cutover, backfill or
superseded behaviour) and the link points to the closest current rule.

| Former ADR | Now | |
| --- | --- | --- |
| `2026-09-10-agent-identity-verified-against-projects-items` | [agents-approvals-and-ai.md — Actors and agent identity](agents-approvals-and-ai.md#actors-and-agent-identity) |  |
| `2026-09-10-agent-writes-are-proposals-not-direct-writes` | [agents-approvals-and-ai.md — The rule](agents-approvals-and-ai.md#the-rule) |  |
| `2026-09-10-ai-gateway-monopoly-on-provider-calls` | [agents-approvals-and-ai.md — Monopoly](agents-approvals-and-ai.md#monopoly) |  |
| `2026-09-10-app-code-post-migration-steps` | [migrations-and-seeding.md — Before the first production release: one editable baseline](migrations-and-seeding.md#before-the-first-production-release-one-editable-baseline) | dropped |
| `2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions` | [transactions-and-side-effects.md — Staleness-checked brackets](transactions-and-side-effects.md#staleness-checked-brackets) |  |
| `2026-09-10-choke-point-api-for-state-writes` | [data-model-and-writes.md — One write path](data-model-and-writes.md#one-write-path) |  |
| `2026-09-10-develop-main-branching-with-release-promotion` | [delivery-and-operations.md — Branches and pull requests](delivery-and-operations.md#branches-and-pull-requests) |  |
| `2026-09-10-diagnostic-notifications-are-not-agent-proposals` | [agents-approvals-and-ai.md — Closed list of direct agent writes](agents-approvals-and-ai.md#closed-list-of-direct-agent-writes) |  |
| `2026-09-10-english-canonical-keys-with-i18n-labels` | [data-model-and-writes.md — Canonical keys and reserved names](data-model-and-writes.md#canonical-keys-and-reserved-names) |  |
| `2026-09-10-expand-contract-forward-only-migrations` | [migrations-and-seeding.md — After the first production release: forward-only, expand/contract](migrations-and-seeding.md#after-the-first-production-release-forward-only-expandcontract) |  |
| `2026-09-10-side-effects-follow-the-commit` | [transactions-and-side-effects.md — Side effects follow the commit](transactions-and-side-effects.md#side-effects-follow-the-commit) |  |
| `2026-09-10-single-monorepo-for-the-whole-product` | [delivery-and-operations.md — Repository layout](delivery-and-operations.md#repository-layout) |  |
| `2026-09-10-single-writer-ownership-model` | [data-model-and-writes.md — One owner, one writer](data-model-and-writes.md#one-owner-one-writer) |  |
| `2026-09-10-typed-rows-at-the-postgres-boundary` | [data-model-and-writes.md — Typed rows at the Postgres boundary](data-model-and-writes.md#typed-rows-at-the-postgres-boundary) |  |
| `2026-09-10-views-are-excluded-from-the-agent-proposal-flow` | [agents-approvals-and-ai.md — Closed list of direct agent writes](agents-approvals-and-ai.md#closed-list-of-direct-agent-writes) |  |
| `2026-09-11-additive-only-rest-contract-no-url-versioning` | [edges-io-and-errors.md — REST contract](edges-io-and-errors.md#rest-contract) |  |
| `2026-09-11-iterative-parent-chain-traversal-in-choke-point` | [data-model-and-writes.md — Reads](data-model-and-writes.md#reads) |  |
| `2026-09-11-module-manifest-custom-routes` | [edges-io-and-errors.md — Custom routes](edges-io-and-errors.md#custom-routes) |  |
| `2026-09-12-per-process-agent-run-watch-registry` | [agents-approvals-and-ai.md — Agent runtime and Semp chat](agents-approvals-and-ai.md#agent-runtime-and-semp-chat) |  |
| `2026-09-12-per-process-doc-sync-subscription-registry` | [edges-io-and-errors.md — Payloads](edges-io-and-errors.md#payloads) |  |
| `2026-09-12-thin-user-scoped-realtime-invalidations` | [edges-io-and-errors.md — Payloads](edges-io-and-errors.md#payloads) |  |
| `2026-09-13-shared-structured-process-logging` | [edges-io-and-errors.md — Logging](edges-io-and-errors.md#logging) |  |
| `2026-09-17-generic-application-service-port` | [edges-io-and-errors.md — Application port](edges-io-and-errors.md#application-port) |  |
| `2026-09-17-shared-package-mirrors-rather-than-imports-data-row-types` | [edges-io-and-errors.md — Application port](edges-io-and-errors.md#application-port) |  |
| `2026-09-17-shutdown-ordering-with-late-heartbeat-stop` | [agents-approvals-and-ai.md — Process lifecycle](agents-approvals-and-ai.md#process-lifecycle) |  |
| `2026-09-17-two-tier-runtime-database-roles` | [tenancy-and-security.md — Runtime roles](tenancy-and-security.md#runtime-roles) |  |
| `2026-09-18-exactly-once-execution-of-approved-destructive-operations` | [transactions-and-side-effects.md — Exactly-once approved operations](transactions-and-side-effects.md#exactly-once-approved-operations) |  |
| `2026-09-18-mcp-json-rpc-transport-for-the-generic-operation-catalog` | [agents-approvals-and-ai.md — MCP](agents-approvals-and-ai.md#mcp) |  |
| `2026-09-18-non-destructive-generic-operations-bypass-agent-approval` | [agents-approvals-and-ai.md — Closed list of direct agent writes](agents-approvals-and-ai.md#closed-list-of-direct-agent-writes) |  |
| `2026-09-18-restricted-mcp-run-credentials-for-approval-gated-calls` | [agents-approvals-and-ai.md — MCP](agents-approvals-and-ai.md#mcp) |  |
| `2026-09-19-derived-system-properties-computed-inline-at-choke-point` | [data-model-and-writes.md — Pre-write transforms](data-model-and-writes.md#pre-write-transforms) | dropped |
| `2026-09-19-task-queue-affinity-routing` | [domain-calendar-tasks-and-media.md — Adjacent rules](domain-calendar-tasks-and-media.md#adjacent-rules) |  |
| `2026-09-20-desired-current-state-sync-for-provider-writebacks` | [transactions-and-side-effects.md — Provider write-backs (desired/current state)](transactions-and-side-effects.md#provider-write-backs-desiredcurrent-state) |  |
| `2026-09-22-ffmpeg-confined-to-semprec-transcribe` | [domain-calendar-tasks-and-media.md — Process placement](domain-calendar-tasks-and-media.md#process-placement) |  |
| `2026-09-22-transcription-queue-affinity-extension` | [domain-calendar-tasks-and-media.md — Process placement](domain-calendar-tasks-and-media.md#process-placement) |  |
| `2026-09-22-transcription-worker-choke-point-access` | [domain-calendar-tasks-and-media.md — Process placement](domain-calendar-tasks-and-media.md#process-placement) | dropped |
| `2026-09-23-host-asset-dependent-database-features-activate-on-every-deploy` | [migrations-and-seeding.md — Host-asset-dependent features](migrations-and-seeding.md#host-asset-dependent-features) |  |
| `2026-09-23-host-scripts-record-results-through-a-data-layer-cli` | [delivery-and-operations.md — Host scripts that record results](delivery-and-operations.md#host-scripts-that-record-results) |  |
| `2026-09-23-processing-proposals-card-creation-owned-per-kind` | [agents-approvals-and-ai.md — Envelope and confirm](agents-approvals-and-ai.md#envelope-and-confirm) | dropped |
| `2026-09-23-transcription-worker-writes-event-match-results` | [domain-calendar-tasks-and-media.md — Event match](domain-calendar-tasks-and-media.md#event-match) |  |
| `2026-09-24-choke-point-composed-from-domain-modules` | [data-model-and-writes.md — Composed from domain modules](data-model-and-writes.md#composed-from-domain-modules) |  |
| `2026-09-24-immutable-releases-behind-an-atomic-current-symlink` | [delivery-and-operations.md — Deploy](delivery-and-operations.md#deploy) |  |
| `2026-09-24-issue-batches-as-dependency-dags` | [delivery-and-operations.md — Issue batches are dependency DAGs](delivery-and-operations.md#issue-batches-are-dependency-dags) |  |
| `2026-09-24-monorepo-release-tag-from-guarded-command` | [delivery-and-operations.md — Releases](delivery-and-operations.md#releases) |  |
| `2026-09-24-rollback-one-release-back-with-checked-migrations` | [delivery-and-operations.md — Rollback](delivery-and-operations.md#rollback) |  |
| `2026-09-26-merged-review-findings-become-proposed-follow-up-issues` | [delivery-and-operations.md — Review findings become follow-up issues](delivery-and-operations.md#review-findings-become-follow-up-issues) |  |
| `2026-09-27-ai-budget-reservations-under-a-global-advisory-lock` | [agents-approvals-and-ai.md — Budgets and accounting](agents-approvals-and-ai.md#budgets-and-accounting) |  |
| `2026-09-27-auto-committed-writes-for-records-that-must-survive-a-failure` | [edges-io-and-errors.md — Records that must survive a failure](edges-io-and-errors.md#records-that-must-survive-a-failure) |  |
| `2026-09-27-runtime-ddl-through-security-definer-functions` | [tenancy-and-security.md — SECURITY DEFINER functions](tenancy-and-security.md#security-definer-functions) |  |
| `2026-09-27-semprec-api-shutdown-ordering` | [agents-approvals-and-ai.md — Process lifecycle](agents-approvals-and-ai.md#process-lifecycle) |  |
| `2026-09-27-ssrf-protection-for-stored-outbound-urls` | [edges-io-and-errors.md — Stored user-supplied URLs](edges-io-and-errors.md#stored-user-supplied-urls) |  |
| `2026-09-28-blob-bytes-deleted-best-effort-after-the-commit` | [domain-calendar-tasks-and-media.md — Ownership and collection](domain-calendar-tasks-and-media.md#ownership-and-collection) |  |
| `2026-09-28-chunked-transactions-for-large-background-sweeps` | [transactions-and-side-effects.md — Chunked background sweeps](transactions-and-side-effects.md#chunked-background-sweeps) |  |
| `2026-09-28-client-disconnect-propagation-in-the-ai-gateway` | [agents-approvals-and-ai.md — Request handling](agents-approvals-and-ai.md#request-handling) |  |
| `2026-09-28-deploy-restarts-only-the-long-running-services` | [delivery-and-operations.md — Deploy](delivery-and-operations.md#deploy) |  |
| `2026-09-28-module-transactional-side-effects-inline-at-choke-point` | [data-model-and-writes.md — Write-time registries (`data/chokePoint/hooks.ts`)](data-model-and-writes.md#write-time-registries-datachokepointhooksts) | dropped |
| `2026-09-28-two-pass-skip-locked-module-data-migration` | [migrations-and-seeding.md — Module data migrations](migrations-and-seeding.md#module-data-migrations) |  |
| `2026-09-29-exactly-once-execution-of-deferred-mcp-tool-calls` | [agents-approvals-and-ai.md — Execution: approved operations run exactly once](agents-approvals-and-ai.md#execution-approved-operations-run-exactly-once) |  |
| `2026-09-29-withtransaction-is-the-sole-transaction-opener` | [transactions-and-side-effects.md — withTransaction is the sole transaction opener](transactions-and-side-effects.md#withtransaction-is-the-sole-transaction-opener) |  |
| `2026-09-30-choke-point-domain-hooks-through-a-per-process-registry` | [data-model-and-writes.md — Write-time registries (`data/chokePoint/hooks.ts`)](data-model-and-writes.md#write-time-registries-datachokepointhooksts) |  |
| `2026-09-30-graceful-shutdown-for-long-running-graphile-worker-tasks` | [domain-calendar-tasks-and-media.md — Process placement](domain-calendar-tasks-and-media.md#process-placement) |  |
| `2026-10-01-rest-only-port-extension-methods` | [edges-io-and-errors.md — Application port](edges-io-and-errors.md#application-port) |  |
| `2026-10-03-agents-worker-choke-point-access` | [agents-approvals-and-ai.md — The rule](agents-approvals-and-ai.md#the-rule) |  |
| `2026-10-03-host-egress-filtered-by-service-uid` | [delivery-and-operations.md — Egress filtering](delivery-and-operations.md#egress-filtering) |  |
| `2026-10-03-per-service-secret-groups` | [delivery-and-operations.md — Secret groups](delivery-and-operations.md#secret-groups) |  |
| `2026-10-03-tenant-isolation-through-row-level-security` | [tenancy-and-security.md — Row-level security](tenancy-and-security.md#row-level-security) |  |
| `2026-10-05-per-tenant-envelope-encryption` | [tenancy-and-security.md — Third-party secrets](tenancy-and-security.md#third-party-secrets) |  |
| `2026-10-05-tenant-scope-propagation` | [tenancy-and-security.md — Scope API](tenancy-and-security.md#scope-api) |  |
| `2026-10-06-system-work-fans-out-per-tenant` | [tenancy-and-security.md — System work fans out per tenant](tenancy-and-security.md#system-work-fans-out-per-tenant) |  |
| `2026-10-07-cross-tenant-router-functions` | [tenancy-and-security.md — Cross-tenant router functions](tenancy-and-security.md#cross-tenant-router-functions) |  |
| `2026-10-08-deploy-time-tenant-work-runs-as-the-runtime-role` | [migrations-and-seeding.md — Deploy-time tenant work](migrations-and-seeding.md#deploy-time-tenant-work) |  |
| `2026-10-08-issue-metadata-selects-relay-model-tiers` | [delivery-and-operations.md — Model tiers](delivery-and-operations.md#model-tiers) |  |
| `2026-10-08-items-partitions-attached-under-share-update-exclusive` | [data-model-and-writes.md — Storage](data-model-and-writes.md#storage) | dropped |
| `2026-10-08-per-tenant-queue-lanes` | [tenancy-and-security.md — Queue lanes and job keys](tenancy-and-security.md#queue-lanes-and-job-keys) |  |
| `2026-10-09-item-create-domain-hooks` | [data-model-and-writes.md — Create (`createItemWithClient`)](data-model-and-writes.md#create-createitemwithclient) |  |
| `2026-10-16-column-tightening-cutover-backfills-as-the-owner` | [migrations-and-seeding.md — Deploy-time tenant work](migrations-and-seeding.md#deploy-time-tenant-work) | dropped |
| `2026-10-16-connect-time-outbound-address-checks` | [edges-io-and-errors.md — Connect-time address policy](edges-io-and-errors.md#connect-time-address-policy) |  |
| `2026-10-16-per-tenant-ai-budgets-with-a-global-safety-cap` | [agents-approvals-and-ai.md — Budgets and accounting](agents-approvals-and-ai.md#budgets-and-accounting) |  |
| `2026-10-16-stdio-mcp-confined-to-admin-tenants` | [agents-approvals-and-ai.md — Actors and agent identity](agents-approvals-and-ai.md#actors-and-agent-identity) |  |
| `2026-10-16-tenant-scoped-realtime-fan-out` | [edges-io-and-errors.md — Channels and tenant envelope](edges-io-and-errors.md#channels-and-tenant-envelope) |  |
| `2026-10-17-admin-membership-and-tenant-status-writes` | [tenancy-and-security.md — Admin membership and tenant status](tenancy-and-security.md#admin-membership-and-tenant-status) |  |
| `2026-10-17-admin-role-without-content-access` | [tenancy-and-security.md — Admin role](tenancy-and-security.md#admin-role) |  |
| `2026-10-17-per-ip-auth-throttles-held-in-process` | [tenancy-and-security.md — Public auth throttles](tenancy-and-security.md#public-auth-throttles) |  |
| `2026-10-17-pre-review-draft-pull-requests-before-verify` | [delivery-and-operations.md — Pre-review draft pull requests](delivery-and-operations.md#pre-review-draft-pull-requests) |  |
| `2026-10-17-secret-link-tokens-travel-in-the-url-fragment` | [tenancy-and-security.md — Secret links](tenancy-and-security.md#secret-links) |  |
| `2026-10-17-stdio-mcp-servers-run-in-a-socket-activated-sandbox` | [delivery-and-operations.md — stdio MCP sandbox](delivery-and-operations.md#stdio-mcp-sandbox) |  |
| `2026-10-17-tenant-data-export-archive` | [tenancy-and-security.md — Data export](tenancy-and-security.md#data-export) |  |
| `2026-10-17-tenant-deactivation-tears-down-in-process-state` | [tenancy-and-security.md — Deactivation teardown](tenancy-and-security.md#deactivation-teardown) |  |
| `2026-10-18-fatal-shutdown-rejection-and-mail-failure-logs` | [domain-mail-and-inbox.md — Sending](domain-mail-and-inbox.md#sending) |  |
| `2026-10-18-same-origin-check-on-unsafe-requests` | [tenancy-and-security.md — Same-origin check](tenancy-and-security.md#same-origin-check) |  |
| `2026-10-18-tenant-export-cross-root-blob-lookup` | [domain-calendar-tasks-and-media.md — Streams](domain-calendar-tasks-and-media.md#streams) |  |
| `2026-10-18-tenant-purge-erases-outside-the-choke-point` | [tenancy-and-security.md — Account deletion and purge](tenancy-and-security.md#account-deletion-and-purge) |  |
| `2026-10-25-library-automation-fills-empty-user-owned-fields` | [domain-calendar-tasks-and-media.md — Library](domain-calendar-tasks-and-media.md#library) |  |
| `2026-10-25-mail-server-settings-allow-the-standard-mail-ports` | [domain-mail-and-inbox.md — Server settings and outbound connections](domain-mail-and-inbox.md#server-settings-and-outbound-connections) |  |
| `2026-10-25-multi-step-proposal-envelope` | [agents-approvals-and-ai.md — Envelope and confirm](agents-approvals-and-ai.md#envelope-and-confirm) |  |
| `2026-10-25-server-driven-inbox-editor-schema` | [domain-mail-and-inbox.md — Editor schemas](domain-mail-and-inbox.md#editor-schemas) |  |
| `2026-10-25-task-and-event-recurrence-model` | [domain-calendar-tasks-and-media.md — Recurrence model (Tasks and Events)](domain-calendar-tasks-and-media.md#recurrence-model-tasks-and-events) |  |
| `2026-10-25-thread-may-split-an-inbox-source` | [domain-mail-and-inbox.md — Cards: kinds and producers](domain-mail-and-inbox.md#cards-kinds-and-producers) |  |
| `2026-10-25-undoing-a-confirmed-proposal-reverses-its-recorded-writes` | [agents-approvals-and-ai.md — Undo, reopen, locked states](agents-approvals-and-ai.md#undo-reopen-locked-states) |  |
| `2026-10-26-owner-controlled-review-bot-pause` | [delivery-and-operations.md — Owner-controlled review pause](delivery-and-operations.md#owner-controlled-review-pause) |  |
| `2026-10-27-platform-discovery-in-the-shared-adr-catalog` | [delivery-and-operations.md — Architecture decision records](delivery-and-operations.md#architecture-decision-records) |  |
| `2026-10-27-repository-issue-identity-and-completion-on-the-reviewed-branch` | [delivery-and-operations.md — Repository Markdown issues](delivery-and-operations.md#repository-markdown-issues) |  |
| `2026-10-27-repository-markdown-issues-with-a-guarded-cutover` | [delivery-and-operations.md — Repository Markdown issues](delivery-and-operations.md#repository-markdown-issues) |  |
| `2026-10-28-mcp-card-confirm-only-prefills-project-grants` | [agents-approvals-and-ai.md — Capabilities and MCP grants](agents-approvals-and-ai.md#capabilities-and-mcp-grants) |  |
| `2026-10-28-module-agent-tools-approval-and-grants` | [agents-approvals-and-ai.md — Module agent tools](agents-approvals-and-ai.md#module-agent-tools) |  |
| `2026-10-28-page-operation-family` | [data-model-and-writes.md — Page operations](data-model-and-writes.md#page-operations) |  |
| `2026-10-28-semp-thread-turns-run-on-a-per-tenant-chat-lane` | [domain-mail-and-inbox.md — Related rules](domain-mail-and-inbox.md#related-rules) |  |
| `2026-10-29-agent-page-write-policy` | [agents-approvals-and-ai.md — Closed list of direct agent writes](agents-approvals-and-ai.md#closed-list-of-direct-agent-writes) |  |
| `2026-10-29-calendars-are-not-shared-between-tenants` | [domain-calendar-tasks-and-media.md — Tenancy](domain-calendar-tasks-and-media.md#tenancy) |  |
| `2026-10-29-custom-route-composition-root-dependencies` | [edges-io-and-errors.md — Custom routes](edges-io-and-errors.md#custom-routes) |  |
| `2026-10-29-events-hold-many-transcripts` | [domain-calendar-tasks-and-media.md — Event match](domain-calendar-tasks-and-media.md#event-match) |  |
| `2026-10-29-file-from-attachment-proposal-step` | [domain-mail-and-inbox.md — Proposal steps](domain-mail-and-inbox.md#proposal-steps) |  |
| `2026-10-29-gmail-pubsub-dispatcher-stops-before-the-mail-live-sync-root` | [domain-mail-and-inbox.md — Live sync root and hosted lifecycles](domain-mail-and-inbox.md#live-sync-root-and-hosted-lifecycles) |  |
| `2026-10-29-imap-idle-connections-through-the-shared-imap-connect-step` | [domain-mail-and-inbox.md — Server settings and outbound connections](domain-mail-and-inbox.md#server-settings-and-outbound-connections) |  |
| `2026-10-29-item-pre-write-transforms-per-module-registry` | [data-model-and-writes.md — Pre-write transforms](data-model-and-writes.md#pre-write-transforms) |  |
| `2026-10-29-mail-connections-through-the-outbound-address-policy` | [domain-mail-and-inbox.md — Server settings and outbound connections](domain-mail-and-inbox.md#server-settings-and-outbound-connections) |  |
| `2026-10-29-module-data-migration-converter-context` | [migrations-and-seeding.md — Module data migrations](migrations-and-seeding.md#module-data-migrations) |  |
| `2026-10-29-page-restore-joins-approval-gated-destructive-operations` | [agents-approvals-and-ai.md — Destructive generic operations](agents-approvals-and-ai.md#destructive-generic-operations) |  |
| `2026-10-29-subpages-are-items-of-a-hidden-pages-database` | [data-model-and-writes.md — Subpages](data-model-and-writes.md#subpages) |  |
| `2026-10-29-tasks-date-and-time-rules-in-pre-write-transform` | [domain-calendar-tasks-and-media.md — Pre-write transform](domain-calendar-tasks-and-media.md#pre-write-transform) |  |
| `2026-10-31-backend-voice-decision-reconciliation` | [agents-approvals-and-ai.md — Voice and speech](agents-approvals-and-ai.md#voice-and-speech) |  |
| `2026-10-31-block-and-page-decision-rationale` | [data-model-and-writes.md — Block model (`shared/block-model/`, package `@semprec/block-model`)](data-model-and-writes.md#block-model-sharedblock-model-package-semprecblock-model) | dropped |
| `2026-10-31-confirmed-proposal-update-preconditions` | [agents-approvals-and-ai.md — Envelope and confirm](agents-approvals-and-ai.md#envelope-and-confirm) |  |
| `2026-10-31-item-origin-capture-time-provenance` | [data-model-and-writes.md — Reads](data-model-and-writes.md#reads) |  |
| `2026-10-31-mail-database-key-cutover` | [migrations-and-seeding.md — Before the first production release: one editable baseline](migrations-and-seeding.md#before-the-first-production-release-one-editable-baseline) | dropped |
| `2026-10-31-owner-delegated-backend-program-supervision` | [delivery-and-operations.md — Backend delivery program](delivery-and-operations.md#backend-delivery-program) |  |
| `2026-10-31-sequential-backend-delivery-batches` | [delivery-and-operations.md — Backend delivery program](delivery-and-operations.md#backend-delivery-program) | dropped |
| `2026-10-31-tenant-scoped-project-references-for-semp-problems` | [agents-approvals-and-ai.md — Agent runtime and Semp chat](agents-approvals-and-ai.md#agent-runtime-and-semp-chat) |  |
| `2026-11-01-atomic-collection-creation-preserves-property-order` | [data-model-and-writes.md — Properties](data-model-and-writes.md#properties) |  |
| `2026-11-01-blob-reference-writes-coordinate-with-collection` | [domain-calendar-tasks-and-media.md — Ownership and collection](domain-calendar-tasks-and-media.md#ownership-and-collection) |  |
| `2026-11-01-bounded-workspace-ids-for-inbox-proposals` | [domain-mail-and-inbox.md — Proposal context](domain-mail-and-inbox.md#proposal-context) |  |
| `2026-11-01-completion-body-rejection-uses-bounded-discard` | [agents-approvals-and-ai.md — Request handling](agents-approvals-and-ai.md#request-handling) |  |
| `2026-11-01-computed-proposal-updates-capture-server-preconditions` | [agents-approvals-and-ai.md — Envelope and confirm](agents-approvals-and-ai.md#envelope-and-confirm) |  |
| `2026-11-01-file-uploads-share-the-blob-filing-lock` | [domain-calendar-tasks-and-media.md — Uploads and attach](domain-calendar-tasks-and-media.md#uploads-and-attach) |  |
| `2026-11-01-gmail-pseudo-folder-cleanup-label-evidence` | [domain-mail-and-inbox.md — Sync pass and the mailbox sync guard](domain-mail-and-inbox.md#sync-pass-and-the-mailbox-sync-guard) | dropped |
| `2026-11-01-inbox-fingerprint-inputs-locked-through-proposal-write` | [domain-mail-and-inbox.md — Tick and the source lock protocol](domain-mail-and-inbox.md#tick-and-the-source-lock-protocol) |  |
| `2026-11-01-mail-thread-mutations-use-a-tenant-transaction-guard` | [domain-mail-and-inbox.md — Mail-thread mutation guard](domain-mail-and-inbox.md#mail-thread-mutation-guard) |  |
| `2026-11-01-mcp-auth-failures-follow-correlated-transport-errors` | [agents-approvals-and-ai.md — MCP](agents-approvals-and-ai.md#mcp) |  |
| `2026-11-01-mcp-connection-observations-commit-independently` | [agents-approvals-and-ai.md — MCP](agents-approvals-and-ai.md#mcp) |  |
| `2026-11-01-page-restore-locks-live-items-and-update-identity` | [tenancy-and-security.md — Trash restore locking](tenancy-and-security.md#trash-restore-locking) |  |
| `2026-11-01-streaming-transcription-provider-outbound-buffer-limit` | [domain-calendar-tasks-and-media.md — Failures and diagnostics](domain-calendar-tasks-and-media.md#failures-and-diagnostics) |  |
| `2026-11-01-stt-stream-close-waits-for-accounting-ownership` | [agents-approvals-and-ai.md — Request handling](agents-approvals-and-ai.md#request-handling) |  |
| `2026-11-01-transcription-http-evidence-uses-an-isolated-producer` | [testing.md — Cross-service composition](testing.md#cross-service-composition) |  |
| `2026-11-01-transcription-queue-errors-exclude-diagnostic-content` | [domain-calendar-tasks-and-media.md — Failures and diagnostics](domain-calendar-tasks-and-media.md#failures-and-diagnostics) |  |
| `2026-11-01-transcription-stop-guards-lock-items-before-automation` | [domain-calendar-tasks-and-media.md — Pipeline locking](domain-calendar-tasks-and-media.md#pipeline-locking) |  |
| `2026-11-01-trash-purge-coordinates-roots-and-transactions` | [transactions-and-side-effects.md — Advisory locks](transactions-and-side-effects.md#advisory-locks) |  |
| `2026-11-01-value-link-handoff-covers-transformed-user-properties` | [data-model-and-writes.md — Value links](data-model-and-writes.md#value-links) |  |
| `2026-11-01-value-link-item-updates-lock-item-before-handoff` | [transactions-and-side-effects.md — Mandatory lock orders](transactions-and-side-effects.md#mandatory-lock-orders) |  |
| `2026-11-01-value-link-relations-use-nonblocking-admission-and-scoped-lock-waits` | [transactions-and-side-effects.md — Busy refusals](transactions-and-side-effects.md#busy-refusals) |  |
| `2026-11-02-ai-usage-report-aggregates-share-one-statement-snapshot` | [agents-approvals-and-ai.md — Budgets and accounting](agents-approvals-and-ai.md#budgets-and-accounting) |  |
| `2026-11-02-bearer-sync-failures-stay-private` | [domain-mail-and-inbox.md — Provider failure privacy](domain-mail-and-inbox.md#provider-failure-privacy) |  |
| `2026-11-02-imap-starttls-cleanup-proves-the-underlying-transport-closed` | [domain-mail-and-inbox.md — Password connect and credential verification](domain-mail-and-inbox.md#password-connect-and-credential-verification) |  |
| `2026-11-02-mail-credential-verification-owns-bounded-policy-connections` | [domain-mail-and-inbox.md — Password connect and credential verification](domain-mail-and-inbox.md#password-connect-and-credential-verification) |  |
| `2026-11-02-mail-oauth-rotation-holds-the-credential-lock-through-refresh` | [domain-mail-and-inbox.md — OAuth token refresh](domain-mail-and-inbox.md#oauth-token-refresh) |  |
| `2026-11-02-mail-verification-cancels-imap-through-owned-sockets` | [domain-mail-and-inbox.md — Password connect and credential verification](domain-mail-and-inbox.md#password-connect-and-credential-verification) |  |
| `2026-11-02-mail-verification-sanitizes-unknown-failures-at-its-public-boundary` | [domain-mail-and-inbox.md — Password connect and credential verification](domain-mail-and-inbox.md#password-connect-and-credential-verification) |  |
| `2026-11-02-markdown-item-links-are-validated-by-tenant-write-owners` | [tenancy-and-security.md — Item links in Markdown](tenancy-and-security.md#item-links-in-markdown) |  |
| `2026-11-02-smtp-and-imap-sync-isolate-secret-bearing-provider-failures` | [domain-mail-and-inbox.md — Provider failure privacy](domain-mail-and-inbox.md#provider-failure-privacy) |  |
| `2026-11-03-approval-notification-undo-copy-follows-application-capability` | [agents-approvals-and-ai.md — What a request shows](agents-approvals-and-ai.md#what-a-request-shows) |  |
| `2026-11-03-confirm-results-report-only-enqueued-follow-ups` | [agents-approvals-and-ai.md — Envelope and confirm](agents-approvals-and-ai.md#envelope-and-confirm) |  |
| `2026-11-03-failed-agent-run-pairing-and-close-share-a-transaction` | [agents-approvals-and-ai.md — Agent runtime and Semp chat](agents-approvals-and-ai.md#agent-runtime-and-semp-chat) |  |
| `2026-11-03-hosted-imap-idle-owns-startup-retries-and-private-diagnostics` | [domain-mail-and-inbox.md — Live sync root and hosted lifecycles](domain-mail-and-inbox.md#live-sync-root-and-hosted-lifecycles) |  |
| `2026-11-03-imap-deadlines-retain-ownership-through-public-settlement` | [domain-mail-and-inbox.md — Provider moves](domain-mail-and-inbox.md#provider-moves) |  |
| `2026-11-03-item-patch-change-redaction-uses-write-metadata` | [agents-approvals-and-ai.md — Redaction of stored agent history](agents-approvals-and-ai.md#redaction-of-stored-agent-history) |  |
| `2026-11-03-later-replay-ledger-covers-snapshot-tombstones` | [tenancy-and-security.md — Backup restore](tenancy-and-security.md#backup-restore) | dropped |
| `2026-11-03-local-development-continues-with-open-production-gates` | [delivery-and-operations.md — Backend delivery program](delivery-and-operations.md#backend-delivery-program) |  |
| `2026-11-03-mail-move-reconcile-baselines-and-prepared-dispatch` | [domain-mail-and-inbox.md — Provider moves](domain-mail-and-inbox.md#provider-moves) |  |
| `2026-11-03-mail-moves-use-durable-step-claims-outside-transactions` | [domain-mail-and-inbox.md — Provider moves](domain-mail-and-inbox.md#provider-moves) |  |
| `2026-11-03-mail-sender-link-writers-retain-the-recorded-sender` | [domain-mail-and-inbox.md — People linking](domain-mail-and-inbox.md#people-linking) |  |
| `2026-11-03-mail-thread-backfill-cli-evidence-uses-isolated-built-exports` | [testing.md — Cross-service composition](testing.md#cross-service-composition) | dropped |
| `2026-11-03-native-workspace-root-exports` | [edges-io-and-errors.md — Service entrypoints and packaging](edges-io-and-errors.md#service-entrypoints-and-packaging) |  |
| `2026-11-03-oauth-mail-send-provider-failures-stay-private` | [domain-mail-and-inbox.md — Provider failure privacy](domain-mail-and-inbox.md#provider-failure-privacy) |  |
| `2026-11-03-offline-compatible-tenant-key-restore` | [tenancy-and-security.md — Backup restore](tenancy-and-security.md#backup-restore) |  |
| `2026-11-03-offline-restore-owns-execs-on-an-authenticated-loopback-bridge` | [tenancy-and-security.md — Backup restore](tenancy-and-security.md#backup-restore) |  |
| `2026-11-03-person-mail-link-jobs-reconcile-current-index-ownership` | [domain-mail-and-inbox.md — People linking](domain-mail-and-inbox.md#people-linking) |  |
| `2026-11-03-restored-services-wait-for-successful-deletion-replay` | [tenancy-and-security.md — Backup restore](tenancy-and-security.md#backup-restore) |  |
| `2026-11-03-semp-problem-occurrences-retain-episode-receipts` | [domain-calendar-tasks-and-media.md — Adjacent rules](domain-calendar-tasks-and-media.md#adjacent-rules) |  |
| `2026-11-03-source-database-row-locks-coordinate-rollup-dependencies-and-archive` | [transactions-and-side-effects.md — Mandatory lock orders](transactions-and-side-effects.md#mandatory-lock-orders) |  |
| `2026-11-04-approval-relation-snapshots-reserve-inserts-and-existing-rows` | [agents-approvals-and-ai.md — Snapshots and reservations](agents-approvals-and-ai.md#snapshots-and-reservations) |  |
| `2026-11-04-approved-item-patches-reserve-database-state` | [transactions-and-side-effects.md — Exactly-once approved operations](transactions-and-side-effects.md#exactly-once-approved-operations) |  |
| `2026-11-04-atomic-item-relations-compose-existing-write-owners` | [data-model-and-writes.md — Relations](data-model-and-writes.md#relations) |  |
| `2026-11-04-blob-content-classification-preserves-legacy-metadata` | [domain-calendar-tasks-and-media.md — Ownership and collection](domain-calendar-tasks-and-media.md#ownership-and-collection) |  |
| `2026-11-04-confirm-results-hold-retained-file-relation-rows` | [domain-calendar-tasks-and-media.md — Uploads and attach](domain-calendar-tasks-and-media.md#uploads-and-attach) | dropped |
| `2026-11-04-document-invalidations-coalesce-lookups-at-delivery` | [edges-io-and-errors.md — Payloads](edges-io-and-errors.md#payloads) |  |
| `2026-11-04-flagged-agent-writes-require-approval` | [agents-approvals-and-ai.md — Flagged agent writes (value-link breaks)](agents-approvals-and-ai.md#flagged-agent-writes-value-link-breaks) |  |
| `2026-11-04-keyed-after-commit-effects-belong-to-the-managed-invocation` | [transactions-and-side-effects.md — Side effects follow the commit](transactions-and-side-effects.md#side-effects-follow-the-commit) |  |
| `2026-11-04-mcp-exposes-module-agent-tools` | [agents-approvals-and-ai.md — MCP](agents-approvals-and-ai.md#mcp) |  |
| `2026-11-04-module-tools-preserve-refusals-and-native-error-results` | [agents-approvals-and-ai.md — Module agent tools](agents-approvals-and-ai.md#module-agent-tools) |  |
| `2026-11-04-oversized-relation-keys-request-a-full-link-refetch` | [transactions-and-side-effects.md — Side effects follow the commit](transactions-and-side-effects.md#side-effects-follow-the-commit) |  |
| `2026-11-04-owned-databases-admit-safe-module-agent-tools` | [agents-approvals-and-ai.md — Capabilities and MCP grants](agents-approvals-and-ai.md#capabilities-and-mcp-grants) |  |
| `2026-11-04-recognition-results-stay-bound-to-the-computed-target` | [agents-approvals-and-ai.md — Computation and grounding](agents-approvals-and-ai.md#computation-and-grounding) |  |
| `2026-11-04-single-owner-voice-channel-admission` | [agents-approvals-and-ai.md — Voice and speech](agents-approvals-and-ai.md#voice-and-speech) |  |
| `2026-11-05-automation-batch-reads-use-the-domain-registry` | [data-model-and-writes.md — Read-time registries](data-model-and-writes.md#read-time-registries) |  |
| `2026-11-05-bounded-behavior-drift-snapshots` | [agents-approvals-and-ai.md — Request handling](agents-approvals-and-ai.md#request-handling) | dropped |
| `2026-11-05-derived-relation-creation-reserves-project-inputs` | [transactions-and-side-effects.md — Busy refusals](transactions-and-side-effects.md#busy-refusals) |  |
| `2026-11-05-item-create-transforms-follow-idempotency-reservation` | [data-model-and-writes.md — Create (`createItemWithClient`)](data-model-and-writes.md#create-createitemwithclient) |  |
| `2026-11-05-library-covers-stage-bytes-before-the-owned-item-transaction` | [domain-calendar-tasks-and-media.md — Library](domain-calendar-tasks-and-media.md#library) |  |
| `2026-11-05-library-outcome-writers-require-a-compatible-reader-predecessor` | [migrations-and-seeding.md — After the first production release: forward-only, expand/contract](migrations-and-seeding.md#after-the-first-production-release-forward-only-expandcontract) |  |
| `2026-11-05-library-retries-require-a-supported-live-source-config` | [domain-calendar-tasks-and-media.md — Library](domain-calendar-tasks-and-media.md#library) |  |
| `2026-11-05-mail-thread-item-merges-transfer-existing-relations` | [domain-mail-and-inbox.md — Merges and Threads relations](domain-mail-and-inbox.md#merges-and-threads-relations) |  |
| `2026-11-05-monotonic-project-guidance-revisions` | [agents-approvals-and-ai.md — Agent runtime and Semp chat](agents-approvals-and-ai.md#agent-runtime-and-semp-chat) |  |
| `2026-11-05-recording-intake-coordinates-files-and-transcription` | [domain-calendar-tasks-and-media.md — Recording intake](domain-calendar-tasks-and-media.md#recording-intake) |  |
| `2026-11-05-recording-intake-preserves-fast-create-jobs` | [domain-calendar-tasks-and-media.md — Recording intake](domain-calendar-tasks-and-media.md#recording-intake) |  |
| `2026-11-05-recording-prepare-write-rechecks-use-read-committed` | [domain-calendar-tasks-and-media.md — Pipeline locking](domain-calendar-tasks-and-media.md#pipeline-locking) |  |
| `2026-11-05-resolved-notification-pagination-keeps-timestamp-ties` | [edges-io-and-errors.md — Bounded reads and pagination](edges-io-and-errors.md#bounded-reads-and-pagination) |  |
| `2026-11-05-task-proposal-preparation-defers-implicit-completion-day` | [domain-calendar-tasks-and-media.md — Pre-write transform](domain-calendar-tasks-and-media.md#pre-write-transform) |  |
| `2026-11-05-thread-relation-writers-reserve-thread-endpoints` | [domain-mail-and-inbox.md — Merges and Threads relations](domain-mail-and-inbox.md#merges-and-threads-relations) |  |
| `2026-11-05-transcription-create-writes-requested-project` | [domain-calendar-tasks-and-media.md — Recording intake](domain-calendar-tasks-and-media.md#recording-intake) |  |
| `2026-11-05-value-link-job-keys-include-the-trusted-tenant` | [tenancy-and-security.md — Queue lanes and job keys](tenancy-and-security.md#queue-lanes-and-job-keys) |  |
| `2026-11-05-value-link-propagation-keeps-separate-hop-budgets` | [agents-approvals-and-ai.md — Flagged agent writes (value-link breaks)](agents-approvals-and-ai.md#flagged-agent-writes-value-link-breaks) |  |
| `2026-11-05-voice-admission-retained-until-handler-settlement` | [agents-approvals-and-ai.md — Voice and speech](agents-approvals-and-ai.md#voice-and-speech) |  |
| `2026-11-05-voice-transport-oversize-closes-before-application-errors` | [agents-approvals-and-ai.md — Voice and speech](agents-approvals-and-ai.md#voice-and-speech) |  |
| `2026-11-06-agent-images-use-bounded-ephemeral-payloads` | [agents-approvals-and-ai.md — Request handling](agents-approvals-and-ai.md#request-handling) |  |
| `2026-11-06-agents-startup-requires-a-quiesced-predecessor` | [agents-approvals-and-ai.md — Process lifecycle](agents-approvals-and-ai.md#process-lifecycle) |  |
| `2026-11-06-blob-open-cleanup-observes-stream-closure` | [domain-calendar-tasks-and-media.md — Streams](domain-calendar-tasks-and-media.md#streams) |  |
| `2026-11-06-inbox-proposal-evidence-uses-a-shared-gateway-fixture` | [testing.md — Cross-service composition](testing.md#cross-service-composition) |  |
| `2026-11-06-inbox-thread-sends-reserve-current-proposals` | [domain-mail-and-inbox.md — Tick and the source lock protocol](domain-mail-and-inbox.md#tick-and-the-source-lock-protocol) |  |
| `2026-11-06-live-voice-evidence-composes-real-gateway-transports` | [testing.md — Cross-service composition](testing.md#cross-service-composition) |  |
| `2026-11-06-live-voice-worker-evidence-uses-an-isolated-agents-fixture` | [testing.md — Cross-service composition](testing.md#cross-service-composition) |  |
| `2026-11-06-message-speech-accounting-uses-an-isolated-gateway-fixture` | [testing.md — Cross-service composition](testing.md#cross-service-composition) |  |
| `2026-11-06-message-speech-cache-brackets-gateway-io` | [agents-approvals-and-ai.md — Voice and speech](agents-approvals-and-ai.md#voice-and-speech) |  |
| `2026-11-06-message-speech-voices-and-session-loss-bounds` | [agents-approvals-and-ai.md — Voice and speech](agents-approvals-and-ai.md#voice-and-speech) |  |
| `2026-11-06-page-capability-registration-does-not-grant-project-agents` | [agents-approvals-and-ai.md — Capabilities and MCP grants](agents-approvals-and-ai.md#capabilities-and-mcp-grants) |  |
| `2026-11-06-reference-readers-own-post-transfer-stream-settlement` | [transactions-and-side-effects.md — Staleness-checked brackets](transactions-and-side-effects.md#staleness-checked-brackets) |  |
| `2026-11-06-semp-message-order-and-session-freshness` | [agents-approvals-and-ai.md — Agent runtime and Semp chat](agents-approvals-and-ai.md#agent-runtime-and-semp-chat) |  |
| `2026-11-06-semp-recovery-does-not-infer-worker-death` | [agents-approvals-and-ai.md — Process lifecycle](agents-approvals-and-ai.md#process-lifecycle) |  |
| `2026-11-06-semp-reference-reads-stay-in-data-owners` | [agents-approvals-and-ai.md — Agent runtime and Semp chat](agents-approvals-and-ai.md#agent-runtime-and-semp-chat) |  |
| `2026-11-06-semp-refs-validate-observed-tenant-state` | [agents-approvals-and-ai.md — Agent runtime and Semp chat](agents-approvals-and-ai.md#agent-runtime-and-semp-chat) |  |
| `2026-11-06-semp-wake-replays-bounded-complete-history` | [agents-approvals-and-ai.md — Agent runtime and Semp chat](agents-approvals-and-ai.md#agent-runtime-and-semp-chat) |  |
| `2026-11-06-speaker-confirm-inserts-participants-without-metadata-replacement` | [domain-calendar-tasks-and-media.md — Speakers](domain-calendar-tasks-and-media.md#speakers) |  |
| `2026-11-06-speech-deadline-bounds-admission-not-db-settlement` | [agents-approvals-and-ai.md — Voice and speech](agents-approvals-and-ai.md#voice-and-speech) |  |
| `2026-11-06-voice-delivery-correlates-individual-semp-turns` | [agents-approvals-and-ai.md — Voice and speech](agents-approvals-and-ai.md#voice-and-speech) |  |
| `2026-11-06-voice-orders-deltas-by-durable-anchor` | [agents-approvals-and-ai.md — Voice and speech](agents-approvals-and-ai.md#voice-and-speech) |  |
| `2026-11-06-voice-speech-bounds-pending-text-per-request` | [agents-approvals-and-ai.md — Voice and speech](agents-approvals-and-ai.md#voice-and-speech) |  |
| `2026-11-06-voice-turns-share-authorized-run-watch-delivery` | [agents-approvals-and-ai.md — Voice and speech](agents-approvals-and-ai.md#voice-and-speech) |  |
| `2026-11-07-agent-query-schemas-share-local-definitions` | [agents-approvals-and-ai.md — Request handling](agents-approvals-and-ai.md#request-handling) |  |
| `2026-11-07-area-note-cutover-reserves-source-without-waiting` | [migrations-and-seeding.md — Before the first production release: one editable baseline](migrations-and-seeding.md#before-the-first-production-release-one-editable-baseline) | dropped |
| `2026-11-07-calendar-cutover-uses-bounded-transactions` | [migrations-and-seeding.md — Before the first production release: one editable baseline](migrations-and-seeding.md#before-the-first-production-release-one-editable-baseline) | dropped |
| `2026-11-07-item-delete-and-restore-domain-hooks` | [tenancy-and-security.md — Trash restore locking](tenancy-and-security.md#trash-restore-locking) |  |
| `2026-11-07-proposal-preparation-uses-trusted-tenant-timezone` | [agents-approvals-and-ai.md — Envelope and confirm](agents-approvals-and-ai.md#envelope-and-confirm) |  |
| `2026-11-07-task-series-cutover-uses-bounded-owner-backfill` | [migrations-and-seeding.md — Before the first production release: one editable baseline](migrations-and-seeding.md#before-the-first-production-release-one-editable-baseline) | dropped |
| `2026-11-08-journal-restore-serializes-on-its-period-reservation` | [domain-calendar-tasks-and-media.md — Journal](domain-calendar-tasks-and-media.md#journal) |  |
| `2026-11-08-nightly-task-rollover-writes-user-owned-schedule` | [domain-calendar-tasks-and-media.md — Nightly rollover](domain-calendar-tasks-and-media.md#nightly-rollover) |  |
| `2026-11-08-restore-hooks-carry-exact-deletion-epochs` | [tenancy-and-security.md — Trash restore locking](tenancy-and-security.md#trash-restore-locking) |  |
| `2026-11-08-search-flush-proof-excludes-legacy-envelope-restamping` | [tenancy-and-security.md — Queue lanes and job keys](tenancy-and-security.md#queue-lanes-and-job-keys) | dropped |
| `2026-11-08-search-lane-enqueues-flush-in-order-under-a-tenant-lock-before-commit` | [tenancy-and-security.md — Queue lanes and job keys](tenancy-and-security.md#queue-lanes-and-job-keys) |  |
| `2026-11-08-upload-attach-rechecks-the-file-blob-binding` | [domain-calendar-tasks-and-media.md — Uploads and attach](domain-calendar-tasks-and-media.md#uploads-and-attach) |  |
| `2026-11-08-upload-attach-reserves-source-and-target` | [domain-calendar-tasks-and-media.md — Uploads and attach](domain-calendar-tasks-and-media.md#uploads-and-attach) |  |
| `2026-11-09-confirmed-page-content-derives-block-ids-from-its-proposal` | [agents-approvals-and-ai.md — Envelope and confirm](agents-approvals-and-ai.md#envelope-and-confirm) |  |
| `2026-11-09-generic-task-recurrence-patches-use-the-series-owner` | [domain-calendar-tasks-and-media.md — Recurring task series](domain-calendar-tasks-and-media.md#recurring-task-series) |  |
| `2026-11-09-inbox-type-edges-reserve-current-cards-without-waiting` | [domain-mail-and-inbox.md — Tick and the source lock protocol](domain-mail-and-inbox.md#tick-and-the-source-lock-protocol) |  |
| `2026-11-09-nightly-recurring-occurrences-use-the-missed-status-handover` | [domain-calendar-tasks-and-media.md — Nightly rollover](domain-calendar-tasks-and-media.md#nightly-rollover) |  |
| `2026-11-09-page-changes-refuses-an-update-larger-than-one-fetch-group` | [data-model-and-writes.md — Page operations](data-model-and-writes.md#page-operations) |  |
| `2026-11-09-page-changes-replays-a-bounded-consistent-history` | [edges-io-and-errors.md — Bounded reads and pagination](edges-io-and-errors.md#bounded-reads-and-pagination) |  |
| `2026-11-09-page-http-routes-and-subpage-paths-follow-delivery-contracts` | [edges-io-and-errors.md — Bounded reads and pagination](edges-io-and-errors.md#bounded-reads-and-pagination) |  |
| `2026-11-09-page-insert-authentication-reuses-scoped-run-callers` | [data-model-and-writes.md — Page operations](data-model-and-writes.md#page-operations) |  |
| `2026-11-09-page-snapshot-and-proposal-id-claims-are-narrowed` | [agents-approvals-and-ai.md — Cross-domain proposal rules](agents-approvals-and-ai.md#cross-domain-proposal-rules) |  |
| `2026-11-09-page-title-mirror-locks-only-children-it-owns` | [transactions-and-side-effects.md — Mandatory lock orders](transactions-and-side-effects.md#mandatory-lock-orders) |  |
| `2026-11-09-page-title-mirror-reserves-the-live-host` | [transactions-and-side-effects.md — Mandatory lock orders](transactions-and-side-effects.md#mandatory-lock-orders) |  |
| `2026-11-09-page-versions-are-content-derived-etags` | [data-model-and-writes.md — Page operations](data-model-and-writes.md#page-operations) |  |
| `2026-11-09-persistent-removal-drains-validated-writers-with-a-properties-lock` | [transactions-and-side-effects.md — DDL locks](transactions-and-side-effects.md#ddl-locks) | dropped |
| `2026-11-09-subpage-parent-chains-are-bounded-while-walked` | [edges-io-and-errors.md — Bounded reads and pagination](edges-io-and-errors.md#bounded-reads-and-pagination) |  |
| `2026-11-09-task-rollover-excludes-its-current-result-state` | [domain-calendar-tasks-and-media.md — Nightly rollover](domain-calendar-tasks-and-media.md#nightly-rollover) |  |
| `2026-11-09-tick-approval-outcomes-use-bounded-acknowledgment-turns` | [agents-approvals-and-ai.md — Agent runtime and Semp chat](agents-approvals-and-ai.md#agent-runtime-and-semp-chat) |  |
| `2026-11-10-a-mailbox-removal-job-joins-the-mailbox-trash-epoch` | [domain-mail-and-inbox.md — Mailbox removal, restore and purge](domain-mail-and-inbox.md#mailbox-removal-restore-and-purge) |  |
| `2026-11-10-calendar-timeline-merges-a-list-of-sources` | [domain-calendar-tasks-and-media.md — Calendar timeline](domain-calendar-tasks-and-media.md#calendar-timeline) |  |
| `2026-11-10-custom-routes-are-matched-in-declaration-order` | [edges-io-and-errors.md — Custom routes](edges-io-and-errors.md#custom-routes) |  |
| `2026-11-10-dismissed-guidance-findings-require-compatible-readers` | [migrations-and-seeding.md — After the first production release: forward-only, expand/contract](migrations-and-seeding.md#after-the-first-production-release-forward-only-expandcontract) |  |
| `2026-11-10-finished-transcripts-are-not-matched-or-suggested-again` | [domain-calendar-tasks-and-media.md — Pipeline locking](domain-calendar-tasks-and-media.md#pipeline-locking) |  |
| `2026-11-10-guidance-write-transaction-exception` | [agents-approvals-and-ai.md — Agent runtime and Semp chat](agents-approvals-and-ai.md#agent-runtime-and-semp-chat) |  |
| `2026-11-10-item-count-schema-shares-local-definitions` | [data-model-and-writes.md — Page operations](data-model-and-writes.md#page-operations) | dropped |
| `2026-11-10-item-purge-domain-hooks` | [data-model-and-writes.md — Items (`data/chokePoint/itemTrash.ts`)](data-model-and-writes.md#items-datachokepointitemtrashts) |  |
| `2026-11-10-journal-duplicate-merge-locks-the-reservation-before-both-entries` | [domain-calendar-tasks-and-media.md — Journal](domain-calendar-tasks-and-media.md#journal) |  |
| `2026-11-10-login-replaces-the-sessions-of-its-installation` | [tenancy-and-security.md — Sessions and login](tenancy-and-security.md#sessions-and-login) |  |
| `2026-11-10-mailbox-oauth-connect-consumes-its-state-before-the-provider-call` | [domain-mail-and-inbox.md — OAuth connect and reauthorization](domain-mail-and-inbox.md#oauth-connect-and-reauthorization) |  |
| `2026-11-10-mailbox-removal-is-one-transaction-that-also-writes-sync-status` | [domain-mail-and-inbox.md — Mailbox removal, restore and purge](domain-mail-and-inbox.md#mailbox-removal-restore-and-purge) |  |
| `2026-11-10-manual-guidance-writes-have-no-realtime-callback` | [agents-approvals-and-ai.md — Agent runtime and Semp chat](agents-approvals-and-ai.md#agent-runtime-and-semp-chat) |  |
| `2026-11-10-page-duplication-copies-the-subtree-as-new-pages` | [data-model-and-writes.md — Page operations](data-model-and-writes.md#page-operations) |  |
| `2026-11-10-page-rename-writes-the-item-title-and-the-parent-block-together` | [data-model-and-writes.md — Page operations](data-model-and-writes.md#page-operations) |  |
| `2026-11-10-parallel-backend-delivery-through-a-serialized-merge-queue` | [delivery-and-operations.md — Backend delivery program](delivery-and-operations.md#backend-delivery-program) |  |
| `2026-11-10-password-change-marks-reset-tokens-before-and-under-the-user-row-lock` | [tenancy-and-security.md — Password reset and change](tenancy-and-security.md#password-reset-and-change) |  |
| `2026-11-10-password-mailbox-connect-rechecks-its-duplicate-rule-at-read-committed` | [domain-mail-and-inbox.md — Password connect and credential verification](domain-mail-and-inbox.md#password-connect-and-credential-verification) |  |
| `2026-11-10-resolved-guidance-notifications-use-a-writer-savepoint` | [agents-approvals-and-ai.md — Agent runtime and Semp chat](agents-approvals-and-ai.md#agent-runtime-and-semp-chat) |  |
| `2026-11-10-select-options-change-on-a-schema-locked-database` | [data-model-and-writes.md — Properties](data-model-and-writes.md#properties) |  |
| `2026-11-10-task-rollover-due-preselection-before-locked-recheck` | [domain-calendar-tasks-and-media.md — Nightly rollover](domain-calendar-tasks-and-media.md#nightly-rollover) |  |
| `2026-11-10-transcript-values-are-inherited-by-link-rules-whichever-process-writes-the-edge` | [domain-calendar-tasks-and-media.md — Value-link inheritance](domain-calendar-tasks-and-media.md#value-link-inheritance) |  |
| `2026-11-10-transcription-create-writes-the-uploads-event` | [domain-calendar-tasks-and-media.md — Recording intake](domain-calendar-tasks-and-media.md#recording-intake) |  |
| `2026-11-11-a-mailboxes-item-is-trashed-only-by-the-system-writer` | [domain-mail-and-inbox.md — Mailbox removal, restore and purge](domain-mail-and-inbox.md#mailbox-removal-restore-and-purge) |  |
| `2026-11-11-a-removed-mailbox-is-cleaned-up-at-the-provider-from-memory-after-the-commit` | [domain-mail-and-inbox.md — Mailbox removal, restore and purge](domain-mail-and-inbox.md#mailbox-removal-restore-and-purge) |  |
| `2026-11-11-a-reviewed-chain-may-land-ahead-of-an-open-shared-file-ordering-blocker` | [delivery-and-operations.md — Backend delivery program](delivery-and-operations.md#backend-delivery-program) |  |
| `2026-11-11-action-item-tasks-inherit-project-and-people-by-link-rules` | [domain-calendar-tasks-and-media.md — Value-link inheritance](domain-calendar-tasks-and-media.md#value-link-inheritance) |  |
| `2026-11-11-an-edge-to-a-trashed-event-is-no-link-for-the-match-and-a-pairing-card` | [domain-calendar-tasks-and-media.md — Event match](domain-calendar-tasks-and-media.md#event-match) |  |
| `2026-11-11-chains-may-land-as-a-train-with-one-gate` | [delivery-and-operations.md — Backend delivery program](delivery-and-operations.md#backend-delivery-program) |  |
| `2026-11-11-event-participant-invitations-are-written-by-system-writers` | [domain-calendar-tasks-and-media.md — Event participants and invitations](domain-calendar-tasks-and-media.md#event-participants-and-invitations) |  |
| `2026-11-11-mail-purge-hook-takes-the-thread-guard-after-the-purge-locks` | [domain-mail-and-inbox.md — Mailbox removal, restore and purge](domain-mail-and-inbox.md#mailbox-removal-restore-and-purge) |  |
| `2026-11-11-mailbox-reauthorization-restarts-the-hosted-lifecycle-in-the-live-sync-roots-context` | [domain-mail-and-inbox.md — OAuth connect and reauthorization](domain-mail-and-inbox.md#oauth-connect-and-reauthorization) |  |
| `2026-11-11-new-events-get-their-calendar-in-a-create-hook` | [domain-calendar-tasks-and-media.md — Event creation and calendar assignment](domain-calendar-tasks-and-media.md#event-creation-and-calendar-assignment) |  |
| `2026-11-11-transcript-action-item-states-serialize-on-the-transcript-row` | [domain-calendar-tasks-and-media.md — Action item states and refs](domain-calendar-tasks-and-media.md#action-item-states-and-refs) |  |
| `2026-11-12-a-manual-speaker-assignment-settles-the-key-card-in-the-confirm-lock-order` | [domain-calendar-tasks-and-media.md — Speakers](domain-calendar-tasks-and-media.md#speakers) |  |
| `2026-11-12-a-push-inside-the-sleep-window-is-held-by-a-deferred-fan-out-job` | [domain-calendar-tasks-and-media.md — Sleep](domain-calendar-tasks-and-media.md#sleep) |  |
| `2026-11-12-a-restored-mailbox-gets-its-sync-state-and-its-mail-back-in-the-restore-transaction` | [domain-mail-and-inbox.md — Mailbox removal, restore and purge](domain-mail-and-inbox.md#mailbox-removal-restore-and-purge) |  |
| `2026-11-12-a-sleep-night-in-the-timeline-is-a-derived-entry-the-user-edits` | [domain-calendar-tasks-and-media.md — Calendar timeline](domain-calendar-tasks-and-media.md#calendar-timeline) |  |
| `2026-11-12-a-sleep-plan-takes-its-wake-days-from-the-other-plans-under-row-locks` | [domain-calendar-tasks-and-media.md — Sleep](domain-calendar-tasks-and-media.md#sleep) |  |
| `2026-11-12-a-trashed-host-takes-its-subpages-into-its-deletion-epoch` | [data-model-and-writes.md — Pages and hosts (`data/docs/pageTrash.ts`)](data-model-and-writes.md#pages-and-hosts-datadocspagetrashts) |  |
| `2026-11-12-an-agent-write-that-ends-a-value-link-requires-approval` | [agents-approvals-and-ai.md — Flagged agent writes (value-link breaks)](agents-approvals-and-ai.md#flagged-agent-writes-value-link-breaks) |  |
| `2026-11-12-an-update-takes-the-module-locks-before-it-locks-the-row` | [data-model-and-writes.md — Update (`updateItemWithClient`)](data-model-and-writes.md#update-updateitemwithclient) |  |
| `2026-11-12-calendar-rows-keep-one-default-under-an-advisory-lock` | [domain-calendar-tasks-and-media.md — Calendars and the default mark](domain-calendar-tasks-and-media.md#calendars-and-the-default-mark) |  |
| `2026-11-12-create-hooks-are-given-the-initial-relations-of-their-create` | [data-model-and-writes.md — Relations](data-model-and-writes.md#relations) |  |
| `2026-11-12-deleting-a-calendar-takes-the-default-mark-lock-and-its-events-into-its-epoch` | [domain-calendar-tasks-and-media.md — Calendars and the default mark](domain-calendar-tasks-and-media.md#calendars-and-the-default-mark) |  |
| `2026-11-12-inbox-editor-schema-pseudo-keys-area-and-markdown` | [domain-mail-and-inbox.md — Editor schemas](domain-mail-and-inbox.md#editor-schemas) |  |
| `2026-11-12-mailbox-credential-verification-is-throttled-per-user` | [domain-mail-and-inbox.md — Password connect and credential verification](domain-mail-and-inbox.md#password-connect-and-credential-verification) |  |
| `2026-11-12-mcp-argument-values-leave-the-server-only-in-the-owners-request-detail` | [agents-approvals-and-ai.md — What a request shows](agents-approvals-and-ai.md#what-a-request-shows) |  |
| `2026-11-12-module-agent-tools-that-require-approval-run-through-a-moduletool-request` | [agents-approvals-and-ai.md — Module agent tools](agents-approvals-and-ai.md#module-agent-tools) |  |
| `2026-11-12-module-queue-tasks-read-their-composition-root-dependencies-from-a-binding` | [domain-calendar-tasks-and-media.md — Adjacent rules](domain-calendar-tasks-and-media.md#adjacent-rules) |  |
| `2026-11-12-page-replace-takes-the-etag-and-trashes-vanished-subpages` | [data-model-and-writes.md — Page operations](data-model-and-writes.md#page-operations) |  |
| `2026-11-12-per-database-agent-grants` | [agents-approvals-and-ai.md — Per-database grants](agents-approvals-and-ai.md#per-database-grants) |  |
| `2026-11-12-task-host-state-is-recomputed-in-the-writing-transaction` | [domain-calendar-tasks-and-media.md — Host Events (task in event)](domain-calendar-tasks-and-media.md#host-events-task-in-event) |  |
| `2026-11-13-a-discarded-mail-draft-loses-its-row-and-draft-writers-lock-the-item-before-the-row` | [domain-mail-and-inbox.md — Drafts](domain-mail-and-inbox.md#drafts) |  |
| `2026-11-13-a-heartbeat-write-tool-approval-shows-what-it-will-write` | [agents-approvals-and-ai.md — Module agent tools](agents-approvals-and-ai.md#module-agent-tools) |  |
| `2026-11-13-a-redacted-create-result-keeps-the-id-of-the-item-it-created` | [agents-approvals-and-ai.md — Redaction of stored agent history](agents-approvals-and-ai.md#redaction-of-stored-agent-history) |  |
| `2026-11-13-a-semp-chat-run-reads-the-heartbeats-of-every-project` | [agents-approvals-and-ai.md — Sensitive databases](agents-approvals-and-ai.md#sensitive-databases) |  |
| `2026-11-13-a-sleep-change-enqueues-one-debounced-resync-job-per-tenant-in-its-write-transaction` | [domain-calendar-tasks-and-media.md — Reminders and resync pushes](domain-calendar-tasks-and-media.md#reminders-and-resync-pushes) |  |
| `2026-11-13-a-sleep-night-ref-opens-the-sleep-data-for-one-turn` | [domain-calendar-tasks-and-media.md — Sleep](domain-calendar-tasks-and-media.md#sleep) |  |
| `2026-11-13-a-task-always-has-a-status` | [domain-calendar-tasks-and-media.md — Pre-write transform](domain-calendar-tasks-and-media.md#pre-write-transform) |  |
| `2026-11-13-a-transcript-card-links-a-virtual-occurrence-by-its-synthetic-id-and-confirm-materializes-it` | [domain-calendar-tasks-and-media.md — Event match](domain-calendar-tasks-and-media.md#event-match) |  |
| `2026-11-13-a-user-attached-ref-grants-one-turn-read-access` | [agents-approvals-and-ai.md — Sensitive databases](agents-approvals-and-ai.md#sensitive-databases) |  |
| `2026-11-13-a-view-system-key-is-unique-per-database-and-written-by-the-system-alone` | [data-model-and-writes.md — Views](data-model-and-writes.md#views) |  |
| `2026-11-13-a-voice-stop-command-cancels-one-semp-turn-through-a-notification` | [agents-approvals-and-ai.md — Voice and speech](agents-approvals-and-ai.md#voice-and-speech) |  |
| `2026-11-13-an-agent-may-not-filter-sort-or-aggregate-a-sensitive-database-it-cannot-read` | [agents-approvals-and-ai.md — Sensitive databases](agents-approvals-and-ai.md#sensitive-databases) |  |
| `2026-11-13-an-event-occurrence-is-an-events-item-named-by-its-series-event-and-date` | [domain-calendar-tasks-and-media.md — Event series and occurrences](domain-calendar-tasks-and-media.md#event-series-and-occurrences) |  |
| `2026-11-13-an-event-recurrence-rule-is-a-user-owned-json-property` | [domain-calendar-tasks-and-media.md — Event series and occurrences](domain-calendar-tasks-and-media.md#event-series-and-occurrences) |  |
| `2026-11-13-an-external-ai-client-on-mcp-is-refused-sensitive-databases` | [agents-approvals-and-ai.md — Sensitive databases](agents-approvals-and-ai.md#sensitive-databases) |  |
| `2026-11-13-an-item-thread-tool-proves-its-card-with-a-shared-lock-on-its-source-edge` | [domain-mail-and-inbox.md — Tick and the source lock protocol](domain-mail-and-inbox.md#tick-and-the-source-lock-protocol) |  |
| `2026-11-13-archived-databases-are-purged-after-the-trash-retention-period` | [data-model-and-writes.md — Archived databases (`data/trash/purgeArchivedDatabases.ts`)](data-model-and-writes.md#archived-databases-datatrashpurgearchiveddatabasests) |  |
| `2026-11-13-card-actions-replay-the-stored-response-of-an-idempotency-key` | [agents-approvals-and-ai.md — Card locks and invalidation](agents-approvals-and-ai.md#card-locks-and-invalidation) |  |
| `2026-11-13-event-trash-and-restore-write-the-tasks-they-host` | [domain-calendar-tasks-and-media.md — Host Events (task in event)](domain-calendar-tasks-and-media.md#host-events-task-in-event) |  |
| `2026-11-13-inbox-editor-schema-rules-read-the-cards-effective-values` | [domain-mail-and-inbox.md — Editor schemas](domain-mail-and-inbox.md#editor-schemas) |  |
| `2026-11-13-items-linked-to-a-sensitive-record-inherit-its-sensitivity` | [agents-approvals-and-ai.md — Sensitive databases](agents-approvals-and-ai.md#sensitive-databases) |  |
| `2026-11-13-journal-periods-reach-the-assistant-through-the-page-family` | [domain-calendar-tasks-and-media.md — Journal](domain-calendar-tasks-and-media.md#journal) |  |
| `2026-11-13-mail-thread-actions-take-the-thread-guard-before-their-item-locks` | [domain-mail-and-inbox.md — Thread actions](domain-mail-and-inbox.md#thread-actions) |  |
| `2026-11-13-page-convert-to-block-trashes-the-page-tree-after-a-confirmed-count` | [agents-approvals-and-ai.md — Cross-domain proposal rules](agents-approvals-and-ai.md#cross-domain-proposal-rules) |  |
| `2026-11-13-page-operations-follow-the-owner-database-grant` | [agents-approvals-and-ai.md — Per-database grants](agents-approvals-and-ai.md#per-database-grants) |  |
| `2026-11-13-related-rows-are-contributed-through-a-per-process-registry` | [data-model-and-writes.md — Read-time registries](data-model-and-writes.md#read-time-registries) |  |
| `2026-11-13-search-groups-register-through-a-per-process-registry` | [data-model-and-writes.md — Read-time registries](data-model-and-writes.md#read-time-registries) |  |
| `2026-11-13-sensitive-tool-results-are-marked-by-the-tool-and-stored-redacted` | [agents-approvals-and-ai.md — Redaction of stored agent history](agents-approvals-and-ai.md#redaction-of-stored-agent-history) |  |
| `2026-11-13-the-approval-gated-heartbeat-write-tools-share-the-read-scope-of-the-heartbeat-tools` | [agents-approvals-and-ai.md — Sensitive databases](agents-approvals-and-ai.md#sensitive-databases) |  |
| `2026-11-13-the-assistant-proposes-a-journal-merge-and-the-user-approves-the-pair` | [domain-calendar-tasks-and-media.md — Journal](domain-calendar-tasks-and-media.md#journal) |  |
| `2026-11-13-the-gateway-announces-a-tenants-first-budget-refusal-of-a-window` | [agents-approvals-and-ai.md — Budgets and accounting](agents-approvals-and-ai.md#budgets-and-accounting) |  |
| `2026-11-13-the-timeline-adds-task-in-event-state-after-its-sources-are-read` | [domain-calendar-tasks-and-media.md — Calendar timeline](domain-calendar-tasks-and-media.md#calendar-timeline) |  |
| `2026-11-13-the-timeline-expands-an-event-series-into-virtual-and-real-occurrences` | [domain-calendar-tasks-and-media.md — Calendar timeline](domain-calendar-tasks-and-media.md#calendar-timeline) |  |
| `2026-11-13-tool-call-arguments-and-assistant-text-after-a-sensitive-read-are-stored-redacted` | [agents-approvals-and-ai.md — Redaction of stored agent history](agents-approvals-and-ai.md#redaction-of-stored-agent-history) |  |
| `2026-11-13-transcript-segment-refs-resolve-in-batches-and-are-labelled-by-display-name` | [domain-calendar-tasks-and-media.md — Action item states and refs](domain-calendar-tasks-and-media.md#action-item-states-and-refs) |  |
| `2026-11-13-transcription-recommends-the-event-of-an-ambiguous-recording` | [domain-calendar-tasks-and-media.md — Event match](domain-calendar-tasks-and-media.md#event-match) |  |
| `2026-11-13-user-overrides-carry-relation-lists-and-step-switches-under-reserved-keys` | [data-model-and-writes.md — Canonical keys and reserved names](data-model-and-writes.md#canonical-keys-and-reserved-names) |  |
| `2026-11-13-voice-speech-rows-are-attributed-to-the-semp-assistant-message-of-the-turn` | [agents-approvals-and-ai.md — Request handling](agents-approvals-and-ai.md#request-handling) |  |
| `2026-11-14-a-computing-card-is-recomputed-by-the-tick-regardless-of-its-fingerprint` | [agents-approvals-and-ai.md — Computation and grounding](agents-approvals-and-ai.md#computation-and-grounding) |  |
| `2026-11-14-a-heartbeat-agent-run-takes-composition-root-dependencies-and-may-run-in-the-project-of-its-item` | [agents-approvals-and-ai.md — Agent runtime and Semp chat](agents-approvals-and-ai.md#agent-runtime-and-semp-chat) |  |
| `2026-11-14-a-mail-draft-attaches-copies-of-held-files-and-trashes-the-files-that-are-its-own` | [domain-mail-and-inbox.md — Drafts](domain-mail-and-inbox.md#drafts) |  |
| `2026-11-14-a-mail-draft-that-holds-a-send-claim-is-refused-to-its-other-writers` | [domain-mail-and-inbox.md — Sending](domain-mail-and-inbox.md#sending) |  |
| `2026-11-14-a-mail-thread-card-proposes-one-task-of-a-thread-and-is-confirmed-as-a-user-write` | [domain-mail-and-inbox.md — Cards: kinds and producers](domain-mail-and-inbox.md#cards-kinds-and-producers) |  |
| `2026-11-14-a-mail-thread-move-records-the-desired-move-before-it-replaces-the-folder-edge` | [domain-mail-and-inbox.md — Thread actions](domain-mail-and-inbox.md#thread-actions) |  |
| `2026-11-14-a-queue-task-may-write-a-user-owned-relation-edge-as-an-agent-with-no-run` | [domain-calendar-tasks-and-media.md — Adjacent rules](domain-calendar-tasks-and-media.md#adjacent-rules) |  |
| `2026-11-14-a-recording-card-claims-a-transcription-follow-up-only-for-the-jobs-it-enqueued` | [domain-calendar-tasks-and-media.md — Recording intake](domain-calendar-tasks-and-media.md#recording-intake) |  |
| `2026-11-14-a-recurring-task-series-is-trashed-and-restored-as-one-cascade` | [domain-calendar-tasks-and-media.md — Recurring task series](domain-calendar-tasks-and-media.md#recurring-task-series) |  |
| `2026-11-14-a-regenerated-semp-reply-is-hidden-from-the-model-by-its-event-range` | [domain-calendar-tasks-and-media.md — Adjacent rules](domain-calendar-tasks-and-media.md#adjacent-rules) |  |
| `2026-11-14-a-rejected-proposal-reopens-without-recomputation` | [agents-approvals-and-ai.md — Undo, reopen, locked states](agents-approvals-and-ai.md#undo-reopen-locked-states) |  |
| `2026-11-14-a-reminders-change-enqueues-one-debounced-resync-job-per-tenant-in-its-write-transaction` | [domain-calendar-tasks-and-media.md — Reminders and resync pushes](domain-calendar-tasks-and-media.md#reminders-and-resync-pushes) |  |
| `2026-11-14-a-savepoint-step-discards-what-it-queued-for-after-the-commit` | [agents-approvals-and-ai.md — Agent runtime and Semp chat](agents-approvals-and-ai.md#agent-runtime-and-semp-chat) |  |
| `2026-11-14-a-source-split-locks-the-card-then-the-source-then-the-source-edge` | [agents-approvals-and-ai.md — Card locks and invalidation](agents-approvals-and-ai.md#card-locks-and-invalidation) |  |
| `2026-11-14-a-standalone-blob-upload-accepts-only-the-inbox-attachment-types` | [domain-mail-and-inbox.md — Capture, uploads and attachments](domain-mail-and-inbox.md#capture-uploads-and-attachments) |  |
| `2026-11-14-a-subscribed-event-in-the-timeline-is-a-read-only-stored-row` | [domain-calendar-tasks-and-media.md — Calendar timeline](domain-calendar-tasks-and-media.md#calendar-timeline) |  |
| `2026-11-14-a-subscribed-event-series-is-expanded-from-its-stored-rows-on-read` | [domain-calendar-tasks-and-media.md — Subscribed events](domain-calendar-tasks-and-media.md#subscribed-events) |  |
| `2026-11-14-a-task-made-from-a-mail-thread-inherits-its-project-and-people` | [domain-mail-and-inbox.md — Inherited values](domain-mail-and-inbox.md#inherited-values) |  |
| `2026-11-14-a-thread-inherits-its-company-and-project-through-resolver-link-rules` | [domain-mail-and-inbox.md — Inherited values](domain-mail-and-inbox.md#inherited-values) |  |
| `2026-11-14-an-agents-mail-send-is-an-approval-request-of-its-own-kind-sent-as-the-user` | [domain-mail-and-inbox.md — Agent sends and MCP mail tools](domain-mail-and-inbox.md#agent-sends-and-mcp-mail-tools) |  |
| `2026-11-14-an-attachment-inherits-the-project-of-its-thread-by-a-link-rule` | [domain-mail-and-inbox.md — Inherited values](domain-mail-and-inbox.md#inherited-values) |  |
| `2026-11-14-an-item-hook-invalidates-the-open-cards-of-an-item-without-waiting-for-a-card-a-confirm-holds` | [agents-approvals-and-ai.md — Card locks and invalidation](agents-approvals-and-ai.md#card-locks-and-invalidation) |  |
| `2026-11-14-an-organizers-update-is-adopted-into-an-event-by-the-calendar-module-until-the-user-changes-the-field` | [domain-calendar-tasks-and-media.md — Event participants and invitations](domain-calendar-tasks-and-media.md#event-participants-and-invitations) |  |
| `2026-11-14-calendar-tools-over-mcp-are-gated-for-a-run-credential-and-run-as-the-user-for-a-session` | [domain-calendar-tasks-and-media.md — Calendar tools over MCP](domain-calendar-tasks-and-media.md#calendar-tools-over-mcp) |  |
| `2026-11-14-inbox-attachment-facts-are-computed-by-semprec-transcribe-and-recorded-once` | [domain-mail-and-inbox.md — Attachment facts, photos and voice notes](domain-mail-and-inbox.md#attachment-facts-photos-and-voice-notes) |  |
| `2026-11-14-inbox-photos-are-read-by-the-proposal-computation-and-cached-on-the-attachment` | [domain-mail-and-inbox.md — Attachment facts, photos and voice notes](domain-mail-and-inbox.md#attachment-facts-photos-and-voice-notes) |  |
| `2026-11-14-inbox-recording-cards-confirm-into-recording-intake` | [domain-mail-and-inbox.md — Cards: kinds and producers](domain-mail-and-inbox.md#cards-kinds-and-producers) |  |
| `2026-11-14-mail-thread-cards-are-produced-by-the-mail-module-when-semp-proposes-a-task` | [domain-mail-and-inbox.md — Cards: kinds and producers](domain-mail-and-inbox.md#cards-kinds-and-producers) |  |
| `2026-11-14-mail-thread-refs-store-the-given-id-and-resolve-label-and-state-at-read-time` | [domain-mail-and-inbox.md — Thread refs](domain-mail-and-inbox.md#thread-refs) |  |
| `2026-11-14-mail-tools-over-mcp-run-as-their-run-or-as-the-session-user` | [domain-mail-and-inbox.md — Agent sends and MCP mail tools](domain-mail-and-inbox.md#agent-sends-and-mcp-mail-tools) |  |
| `2026-11-14-mcp-tool-classification-is-owned-by-the-annotation-sync-until-a-person-sets-it` | [agents-approvals-and-ai.md — Capabilities and MCP grants](agents-approvals-and-ai.md#capabilities-and-mcp-grants) |  |
| `2026-11-14-mcp-tool-label-suggestions-fill-only-empty-display-labels` | [agents-approvals-and-ai.md — Capabilities and MCP grants](agents-approvals-and-ai.md#capabilities-and-mcp-grants) |  |
| `2026-11-14-retiring-an-outdated-semp-draft-takes-the-steps-of-a-discard-as-the-system` | [agents-approvals-and-ai.md — Cross-domain proposal rules](agents-approvals-and-ai.md#cross-domain-proposal-rules) |  |
| `2026-11-14-speaker-suggestions-are-asked-again-when-the-event-or-its-participants-change` | [domain-calendar-tasks-and-media.md — Speakers](domain-calendar-tasks-and-media.md#speakers) |  |
| `2026-11-14-the-calendar-timeline-tool-leaves-out-sleep-nights-the-caller-may-not-read` | [domain-calendar-tasks-and-media.md — Calendar timeline](domain-calendar-tasks-and-media.md#calendar-timeline) |  |
| `2026-11-14-the-journal-method-cutover-converts-trashed-types-with-one-statement` | [migrations-and-seeding.md — Before the first production release: one editable baseline](migrations-and-seeding.md#before-the-first-production-release-one-editable-baseline) | dropped |
| `2026-11-14-the-mail-send-tool-is-declared-without-deferral-and-files-its-own-approval-request` | [domain-mail-and-inbox.md — Agent sends and MCP mail tools](domain-mail-and-inbox.md#agent-sends-and-mcp-mail-tools) |  |
| `2026-11-14-the-next-occurrence-date-of-an-event-is-a-stored-system-property` | [domain-calendar-tasks-and-media.md — Next occurrence date](domain-calendar-tasks-and-media.md#next-occurrence-date) |  |
| `2026-11-14-the-undo-of-a-confirmation-reverses-only-the-edges-it-recorded` | [agents-approvals-and-ai.md — Undo, reopen, locked states](agents-approvals-and-ai.md#undo-reopen-locked-states) |  |
| `2026-11-14-thread-task-people-follow-the-conversation-by-additions-under-the-task-lock` | [domain-mail-and-inbox.md — Inherited values](domain-mail-and-inbox.md#inherited-values) |  |
| `2026-11-14-transcript-cards-are-recomputed-by-their-producer-on-instruction` | [domain-calendar-tasks-and-media.md — Transcript cards recompute](domain-calendar-tasks-and-media.md#transcript-cards-recompute) |  |
| `2026-11-14-undoing-a-journal-entry-confirmation-leaves-its-day` | [domain-calendar-tasks-and-media.md — Journal](domain-calendar-tasks-and-media.md#journal) |  |
| `2026-11-15-a-blob-writer-consumes-its-source-from-the-tick-it-is-called` | [domain-calendar-tasks-and-media.md — Streams](domain-calendar-tasks-and-media.md#streams) |  |
| `2026-11-15-a-database-proposal-may-carry-page-sections-for-the-item-its-confirm-creates` | [agents-approvals-and-ai.md — Envelope and confirm](agents-approvals-and-ai.md#envelope-and-confirm) |  |
| `2026-11-15-a-database-proposal-may-create-select-options-when-it-is-confirmed` | [agents-approvals-and-ai.md — Envelope and confirm](agents-approvals-and-ai.md#envelope-and-confirm) |  |
| `2026-11-15-a-files-projects-follow-its-tasks-by-a-link-rule` | [domain-calendar-tasks-and-media.md — Value-link inheritance](domain-calendar-tasks-and-media.md#value-link-inheritance) |  |
| `2026-11-15-a-journal-merge-does-not-refuse-an-edge-the-survivor-holds-and-logs-the-field-of-each-refusal` | [domain-calendar-tasks-and-media.md — Journal](domain-calendar-tasks-and-media.md#journal) |  |
| `2026-11-15-a-mailbox-removal-waits-a-bounded-time-for-the-sync-guard-and-answers-busy` | [domain-mail-and-inbox.md — Sync pass and the mailbox sync guard](domain-mail-and-inbox.md#sync-pass-and-the-mailbox-sync-guard) |  |
| `2026-11-15-a-restore-creates-the-cluster-roles-before-the-dump-and-imports-no-key-of-a-deleting-tenant` | [tenancy-and-security.md — Backup restore](tenancy-and-security.md#backup-restore) |  |
| `2026-11-15-a-user-edge-write-on-a-link-rules-via-relation-locks-the-rules-target-item-before-ending-value-links` | [transactions-and-side-effects.md — Mandatory lock orders](transactions-and-side-effects.md#mandatory-lock-orders) |  |
| `2026-11-15-an-event-attachments-company-link-ends-with-the-attachment` | [domain-mail-and-inbox.md — Inherited values](domain-mail-and-inbox.md#inherited-values) |  |
| `2026-11-15-an-exact-match-duplicate-company-or-person-in-a-proposal-is-a-step-that-writes-nothing-to-the-existing-item` | [agents-approvals-and-ai.md — Envelope and confirm](agents-approvals-and-ai.md#envelope-and-confirm) |  |
| `2026-11-15-an-open-proposal-keeps-the-blobs-its-envelope-names` | [domain-calendar-tasks-and-media.md — Ownership and collection](domain-calendar-tasks-and-media.md#ownership-and-collection) |  |
| `2026-11-15-default-inbox-types-are-seeded-once-per-default-under-the-settings-row-lock` | [migrations-and-seeding.md — Defaults a user may delete](migrations-and-seeding.md#defaults-a-user-may-delete) |  |
| `2026-11-15-integration-tests-run-strict-unless-listed` | [testing.md — Tenant scope mode per file](testing.md#tenant-scope-mode-per-file) |  |
| `2026-11-15-live-sync-discovery-seeds-a-sync-state-only-under-a-non-waiting-share-lock-on-the-live-mailbox` | [domain-mail-and-inbox.md — Live sync root and hosted lifecycles](domain-mail-and-inbox.md#live-sync-root-and-hosted-lifecycles) |  |
| `2026-11-15-security-definer-search-path-ends-with-pg-temp` | [tenancy-and-security.md — SECURITY DEFINER functions](tenancy-and-security.md#security-definer-functions) |  |
| `2026-11-15-tenant-purge-erases-the-tenants-queue-rows` | [tenancy-and-security.md — Account deletion and purge](tenancy-and-security.md#account-deletion-and-purge) |  |
| `2026-11-15-the-approval-check-of-a-relation-delete-locks-the-edges-endpoint-rows-before-it-reserves-its-value-links` | [agents-approvals-and-ai.md — Snapshots and reservations](agents-approvals-and-ai.md#snapshots-and-reservations) |  |
| `2026-11-15-the-inbox-proposal-context-is-read-as-the-semprec-project-with-bounded-fields` | [domain-mail-and-inbox.md — Proposal context](domain-mail-and-inbox.md#proposal-context) |  |
| `2026-11-15-the-permanent-purge-locks-only-a-row-that-is-still-trashed-past-the-cutoff` | [data-model-and-writes.md — Items (`data/chokePoint/itemTrash.ts`)](data-model-and-writes.md#items-datachokepointitemtrashts) |  |
| `2026-11-15-the-proposal-request-carries-the-target-databases-known-text-values-under-the-same-grants` | [agents-approvals-and-ai.md — Computation and grounding](agents-approvals-and-ai.md#computation-and-grounding) |  |
| `2026-11-15-the-side-role-cannot-create-an-actor-or-read-credentials` | [tenancy-and-security.md — Runtime roles](tenancy-and-security.md#runtime-roles) |  |
| `2026-11-15-the-trash-of-an-event-locks-the-value-links-it-feeds-in-item-order-then-rule-order` | [domain-calendar-tasks-and-media.md — Event trash: lock order](domain-calendar-tasks-and-media.md#event-trash-lock-order) |  |
| `2026-11-15-the-trash-of-an-event-takes-the-rows-of-the-tasks-it-hosts-before-the-value-links-it-detaches` | [domain-calendar-tasks-and-media.md — Event trash: lock order](domain-calendar-tasks-and-media.md#event-trash-lock-order) |  |
| `2026-11-15-the-value-no-event-of-a-recording-requests-event-decision-is-the-explicit-no-event-choice` | [domain-calendar-tasks-and-media.md — Recording intake](domain-calendar-tasks-and-media.md#recording-intake) |  |
| `2026-11-15-the-voice-notes-of-an-inbox-item-are-transcribed-into-a-property-the-transcribe-process-owns` | [domain-mail-and-inbox.md — Attachment facts, photos and voice notes](domain-mail-and-inbox.md#attachment-facts-photos-and-voice-notes) |  |
| `2026-11-15-workspace-root-exports-for-the-service-entrypoints` | [edges-io-and-errors.md — Service entrypoints and packaging](edges-io-and-errors.md#service-entrypoints-and-packaging) |  |
