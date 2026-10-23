-- Issue #169: one row per named internal-degradation check (process staleness, queue backlog,
-- permanently-failed jobs, per-mailbox sync staleness). `observability.checkSystem` (registered
-- every minute) upserts each check's current status here on every tick, only moving `changed_at`
-- forward when `status` actually flips — this is the durable state an ok->alerting transition is
-- read against so a restart of the checking process itself can never re-fire a notification for a
-- fault that was already alerting before the restart.
CREATE TABLE observability_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_key text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('ok', 'alerting')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  changed_at timestamptz NOT NULL DEFAULT now()
);
