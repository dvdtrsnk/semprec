CREATE TABLE ai_gateway_calls (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  provider text NOT NULL,
  model text NOT NULL,
  input_tokens integer,           -- NULL = this call has no token concept (diarize()/transcribe()); NOT the same as 0
  output_tokens integer,          -- same
  audio_seconds numeric,          -- NULL unless the call has audio input; native unit for diarize()/transcribe()
  cost_usd numeric NOT NULL,
  agent_run_id uuid REFERENCES agent_runs(id)   -- nullable, not every call originates inside a run (transcription, embeddings)
);

CREATE INDEX ai_gateway_calls_agent_run_idx ON ai_gateway_calls (agent_run_id);
