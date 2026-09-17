-- Runtime least-privilege Postgres roles (issue #243).
--
-- Two roles, one per connection-string tier a service can be handed:
--
--   semprec_data — full DML on the choke-point tables only (the tables the generic
--     choke-point in packages/data/src/chokePoint/ writes inside its own transactions).
--     Sufficient, on its own, to complete every generic create/update/delete/relate/view
--     transaction. This is the connection string `semprec-api` uses: it is the one service
--     that hosts the choke-point (every route in backend/services/semprec-api/src/*Handler.ts
--     calls `createChokePoint(pool)` against its own pool), and — because that pool is also
--     the one pool the process uses for its own side-table writes started in the same
--     process (`startProcessHeartbeat`'s `process_heartbeats` row, mail ingest, doc
--     persistence, blob metadata alongside a Files item in `fileUploadStore.ts`'s single
--     transaction) — `semprec_data` is granted membership in `semprec_side` below so it
--     inherits full access to every side table and the queue too. It does not, on its own,
--     gain any privilege `semprec_side` doesn't already have; the split that actually matters
--     for least privilege is the other direction.
--
--   semprec_side — read-only (`SELECT`) on the choke-point tables, full DML on every module
--     side table, and full access to the queue (graphile-worker's own `graphile_worker`
--     schema, granted separately by `grantQueueSchemaPrivileges` in packages/queue once that
--     schema exists — it doesn't exist yet at migration time). This is the connection string
--     every other service gets (`semprec-ai-gateway` today; `semprec-agents`,
--     `semprec-mailsync`, `semprec-transcribe` when they exist) — none of them call
--     `createChokePoint`, so none of them can be handed a role that can mutate `items`.
--     `INSERT`/`UPDATE`/`DELETE` against a choke-point table under this role fails outright,
--     so a bug that tries to bypass the choke-point from one of these services is caught by
--     Postgres itself, not just by review.
--
-- Both roles are created without a password: the actual secret is provisioned per-environment
-- (issue #175's "shared/.env"), never committed here. `LOGIN` is granted so a deployment can
-- set one with `ALTER ROLE ... WITH PASSWORD`.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'semprec_data') THEN
    CREATE ROLE semprec_data LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'semprec_side') THEN
    CREATE ROLE semprec_side LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;

-- See the header note: `semprec_data` completes a generic transaction that also touches a
-- side table (e.g. `fileUploadStore.ts`'s blob-plus-item transaction, or this same process's
-- own `process_heartbeats` row) only because it inherits every `semprec_side` grant too.
GRANT semprec_side TO semprec_data;

GRANT USAGE ON SCHEMA public TO semprec_data, semprec_side;

-- The choke-point's own tables (backend/packages/data/src/chokePoint/*.ts — including
-- `rollup_dependencies`, upserted from inside the same transaction by
-- `chokePoint.ts`'s call into `rollup/dependencies.ts`). `semprec_data` gets full DML;
-- `semprec_side` gets read-only, matching the issue's Task ("GRANT SELECT on the choke-point
-- tables"). A future migration that adds a new table the choke-point writes must extend both
-- grants below in the same migration — there is no default-privilege rule doing this
-- automatically, by design, so adding a choke-point table is always a visible, reviewable grant.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  databases, properties, relation_definitions, items, item_relations,
  views, view_items, idempotency_keys, rollup_dependencies
TO semprec_data;

GRANT SELECT ON
  databases, properties, relation_definitions, items, item_relations,
  views, view_items, idempotency_keys, rollup_dependencies
TO semprec_side;

-- Every other table this schema has (module side tables): full DML to `semprec_side` (and,
-- via the role membership above, to `semprec_data` too). Same "extend in the migration that
-- adds the table" convention as above.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, project_heartbeats, agent_runs, resource_grants,
  mail_account_sync_state, mail_folder_sync_state, mail_threads, mail_message_meta,
  mail_attachments, external_credentials, credential_access_log, person_email_index,
  item_search_index, item_automation, docs, doc_snapshots, doc_updates,
  doc_snapshot_history, mcp_tool_registrations, project_mcp_grants,
  password_reset_tokens, task_recurrence, blobs, project_agent_guidance,
  module_migrations, ai_gateway_calls, agent_run_events, manifest_drift_findings,
  notifications, heartbeat_occurrences, push_subscriptions, approval_requests,
  sessions, login_attempts, doc_history_updates, agent_guidance_drift_findings,
  process_heartbeats, push_deliveries, observability_checks
TO semprec_side;

-- Several side tables above (agent_run_events, ai_gateway_calls, mail_threads, docs,
-- login_attempts, agent_runs' wake_seq) key or tiebreak on a `bigserial` column, whose
-- `nextval()` default requires sequence privileges independent of the table grants above --
-- none of the choke-point tables use a serial column (they key on `gen_random_uuid()`), so this
-- is scoped to `semprec_side` only, matching the side-table grant it rides along with.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO semprec_side;

-- The grant above is a point-in-time snapshot of sequences that exist right now. Without this,
-- a later migration that adds a bigserial column to an existing (or new) side table would
-- silently need a follow-up sequence grant nobody would think to add, and semprec_side inserts
-- into that table would fail at runtime with a privilege error instead of at review time. This
-- mirrors grantQueueSchemaPrivileges's ALTER DEFAULT PRIVILEGES for the graphile_worker schema
-- in packages/queue/src/index.ts, applied here to the public schema instead.
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO semprec_side;
