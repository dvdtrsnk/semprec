-- Issue #168: one row per running process identity (api, agents, transcribe, ai-gateway, and
-- mailsync:<mailboxItemId>), UPSERTed every 15 seconds from that process's own event loop.
-- `beat_at` older than 60 seconds means stale — GET /healthz reads this table to answer whether
-- the agents process is still alive, and it is the source for deriving which processes are
-- currently expected to be beating at all.
CREATE TABLE process_heartbeats (
  process text PRIMARY KEY,
  pid integer NOT NULL,
  version text NOT NULL,
  started_at timestamptz NOT NULL,
  beat_at timestamptz NOT NULL
);
