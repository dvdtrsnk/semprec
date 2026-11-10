-- The tenant-consistent twin prevents a scoped finding from naming another tenant's user.
-- Existing NULL and same-tenant references remain unchanged; incompatible rows fail validation.
ALTER TABLE agent_guidance_drift_findings
  ADD CONSTRAINT agent_guidance_drift_findings_resolved_by_tenant_fkey
  FOREIGN KEY (tenant_id, resolved_by) REFERENCES users (tenant_id, id) NOT VALID;
ALTER TABLE agent_guidance_drift_findings
  VALIDATE CONSTRAINT agent_guidance_drift_findings_resolved_by_tenant_fkey;
