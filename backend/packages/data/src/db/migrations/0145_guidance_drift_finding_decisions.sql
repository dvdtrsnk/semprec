ALTER TABLE agent_guidance_drift_findings
  ADD COLUMN resolved_by uuid REFERENCES users(id),
  ADD COLUMN resolution_choice text CHECK (resolution_choice IN ('allow', 'forbid', 'dismiss'));

ALTER TABLE agent_guidance_drift_findings DROP CONSTRAINT agent_guidance_drift_findings_status_check;
ALTER TABLE agent_guidance_drift_findings ADD CONSTRAINT agent_guidance_drift_findings_status_check
  CHECK (status IN ('active', 'resolved', 'dismissed'));
