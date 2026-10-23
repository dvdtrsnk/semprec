-- Issue #620: the gateway reserves a row before each provider call (status 'reserved', cost_usd
-- = the caller's estimate) under an advisory lock, then settles it with the real usage or marks
-- it 'failed' at cost 0. Expand-only: the previous release's INSERT omits `status` and gets
-- 'settled', which is exactly what its rows are.
ALTER TABLE ai_gateway_calls ADD COLUMN status text NOT NULL DEFAULT 'settled';
ALTER TABLE ai_gateway_calls ADD CONSTRAINT ai_gateway_calls_status_check CHECK (status IN ('reserved', 'settled', 'failed'));

-- The budget check's spend query filters on `at` on every call; without this it scans the table.
CREATE INDEX ai_gateway_calls_at_idx ON ai_gateway_calls (at);
