-- Durable desired/current state for the two user-owned Email flags. The generic
-- choke point records the desired value; mailsync records provider observations and
-- confirmations. Keeping both lets a restart resume a pending provider write without
-- echoing an observation that has already converged.
CREATE TABLE mail_message_flag_sync_state (
  message_item_id uuid NOT NULL,
  property_key text NOT NULL CHECK (property_key IN ('read', 'flagged')),
  desired_state boolean NOT NULL,
  current_state boolean,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_item_id, property_key)
);

CREATE INDEX mail_message_flag_sync_state_pending_idx
  ON mail_message_flag_sync_state (message_item_id)
  WHERE current_state IS DISTINCT FROM desired_state;
