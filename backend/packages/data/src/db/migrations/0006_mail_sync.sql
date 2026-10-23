-- IMAP sync core (issue #26): the tables backing the three sync adapters
-- (imap / gmail_api / graph_api), conversation threading, deterministic
-- People-by-address linking, attachments, reversible credential storage, and
-- full-text search over synced message content.
--
-- No Postgres FK to `items(id)` on any `item_id`/`*_item_id` column below, same
-- reason as `item_relations`/`task_recurrence`/`view_items.item_id`/
-- `item_automation.item_id`: `items` is PARTITION BY LIST (database_id) with
-- composite PK (database_id, id), so a bare `REFERENCES items(id)` cannot be
-- expressed. Referential integrity for these columns is enforced at the
-- application layer, same as those tables. (Issue #25's merge note flags this
-- exact deviation as already-established precedent for this issue by name.)

-- One row per Mailbox item — which adapter it syncs through and that
-- adapter's liveness bookkeeping. `sync_mode` defaults by provider but is
-- manually switchable; nothing here enforces the default, that's an
-- application-layer concern at Mailbox-creation time.
CREATE TABLE mail_account_sync_state (
  item_id uuid PRIMARY KEY,
  sync_mode text NOT NULL CHECK (sync_mode IN ('imap', 'gmail_api', 'graph_api')),
  gmail_history_id text,
  gmail_watch_expires_at timestamptz,
  graph_subscription_id text,
  graph_subscription_expires_at timestamptz,
  -- Gap in the issue's own DDL: `/messages/delta`'s `deltaLink` (the graph_api analogue of
  -- `gmail_history_id`) needs somewhere to persist between runs, same as historyId, but no
  -- column for it was specified. Added mailbox-wide (not per-folder) via `/me/messages/delta`,
  -- mirroring gmail_history_id's account-level scope rather than mail_folder_sync_state.
  graph_delta_link text,
  last_error text,
  last_activity_at timestamptz,
  -- Consumed by the observability check (issue #39, mail_sync_stalled) as a single
  -- uniform `next_expected_activity_at < now()` predicate — this table never expresses
  -- that check itself, only the input it reads.
  next_expected_activity_at timestamptz
);

-- One row per Folder item, IMAP adapter only (Gmail/Graph address messages by their
-- own id, not a per-folder UID) — UIDVALIDITY/UIDNEXT/HIGHESTMODSEQ bookkeeping.
CREATE TABLE mail_folder_sync_state (
  item_id uuid PRIMARY KEY,
  uidvalidity bigint,
  uidnext bigint,
  -- NULL = server doesn't support CONDSTORE (checked via CAPABILITY) — falls back to a
  -- full UID diff reconcile instead of `CHANGEDSINCE`/`VANISHED`.
  highestmodseq bigint,
  last_full_reconcile_at timestamptz,
  last_error text
);

-- Not an item — a plain internal grouping row referenced by mail_message_meta.thread_id.
CREATE TABLE mail_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_hint text
);

-- One row per Email item — the RFC 5322 threading identity and structured envelope.
-- `references` is quoted: a reserved word in standard SQL (still fine unquoted in
-- Postgres, but quoting keeps this migration portable/consistent with the issue's DDL).
CREATE TABLE mail_message_meta (
  item_id uuid PRIMARY KEY,
  message_id text NOT NULL UNIQUE,
  in_reply_to text,
  "references" text[],
  thread_id uuid REFERENCES mail_threads(id),
  provider_thread_id text,
  provider_message_id text,
  envelope jsonb NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX mail_message_meta_provider_msg_uq
  ON mail_message_meta (provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX mail_message_meta_thread_id_idx ON mail_message_meta (thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX mail_message_meta_in_reply_to_idx ON mail_message_meta (in_reply_to) WHERE in_reply_to IS NOT NULL;
-- Reverse lookup for threading's "does an already-synced message reference me" self-heal
-- check (packages/data/src/mail/threading.ts) — a new message arriving after its replies did.
CREATE INDEX mail_message_meta_references_gin ON mail_message_meta USING GIN ("references");

-- One row per real (non-inline-cid) attachment. `message_item_id` -> an Email item,
-- `blob_id` -> `blobs` (0004_ten_databases.sql; a normal, unpartitioned table, so a real
-- FK is valid and used here, unlike the item_id columns above).
CREATE TABLE mail_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_item_id uuid NOT NULL,
  blob_id uuid NOT NULL REFERENCES blobs(id),
  filename text NOT NULL,
  content_type text NOT NULL,
  content_id text,
  disposition text NOT NULL CHECK (disposition IN ('attachment', 'inline')),
  byte_size bigint NOT NULL
);

CREATE INDEX mail_attachments_message_item_id_idx ON mail_attachments (message_item_id);

-- Reversible-encryption credential storage — generic, not email-specific: `item_id` can
-- reference a Mailbox, an MCP server (issue #31), or any future consumer, all equally
-- generic `items` rows. Deliberately named away from `credentials` (the future `users`
-- login table, issue #34, is hashed, not encrypted, and has no `items` row at all).
CREATE TABLE external_credentials (
  item_id uuid PRIMARY KEY,
  credential_type text NOT NULL
    CHECK (credential_type IN ('oauth2_refresh_token', 'app_password', 'plain_password', 'api_key', 'bearer_token')),
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  key_version smallint NOT NULL DEFAULT 1
);

-- Every decryption (not every write) is logged here — see packages/credentials and
-- packages/data/src/credentials/externalCredentialsStore.ts. No FK on item_id, same
-- reason as external_credentials.item_id above.
CREATE TABLE credential_access_log (
  id bigserial PRIMARY KEY,
  item_id uuid NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'sync_worker', 'smtp_send', 'mcp_connection_manager', 'ai_agent')),
  actor_id text,
  purpose text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX credential_access_log_item_id_idx ON credential_access_log (item_id);

-- Deterministic (non-AI) reverse index from a normalized email address to the one People
-- item it belongs to. `email PRIMARY KEY` is the enforced guarantee that one address never
-- belongs to two people at once — a second person claiming an already-indexed address hits
-- a conflict here, not a silent overwrite.
CREATE TABLE person_email_index (
  email text PRIMARY KEY,
  item_id uuid NOT NULL
);

CREATE INDEX person_email_index_item_id_idx ON person_email_index (item_id);

-- Full-text search over synced message content (Emails only, this issue's scope) —
-- maintained by the application's write path (mail ingest), not a DB trigger, mirroring
-- why this isn't a generated column: "which properties of a given DB are searchable"
-- already lives in application code, no need to duplicate it in plpgsql.
CREATE TABLE item_search_index (
  item_id uuid PRIMARY KEY,
  database_id uuid NOT NULL REFERENCES databases(id),
  search_vector tsvector NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX item_search_index_gin ON item_search_index USING GIN (search_vector);
CREATE INDEX item_search_index_db_id ON item_search_index (database_id);

-- `unaccent` (bundled contrib) gives diacritic-insensitive matching. Deviation from the
-- issue's "hunspell cs_CZ dictionary" text search configuration: a hunspell dictionary is
-- an operating-system-level asset (dictionary files under the Postgres tsearch_data
-- directory), not something a SQL migration can install — it has to be provisioned by
-- server setup (issue #40), and isn't present in this migration's test/CI environment
-- either. This migration instead builds a `czech` configuration on top of the always-available
-- `simple` parser (word matching, no stemming) with `unaccent` folding applied to every
-- token type, which is a strict subset of what the hunspell-backed configuration issue #40
-- can later swap in — `websearch_to_tsquery('czech', ...)` and `ts_rank_cd` keep working
-- unchanged either way, only the quality of stemming/matching improves.
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TEXT SEARCH CONFIGURATION czech (COPY = simple);
ALTER TEXT SEARCH CONFIGURATION czech
  ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part
  WITH unaccent, simple;
