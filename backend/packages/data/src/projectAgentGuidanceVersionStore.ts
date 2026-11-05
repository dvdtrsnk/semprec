import type { PoolClient } from "pg";
import { requireAffectedRows, requireSingleRow } from "./db/pool.js";

/** Private owner of the per-tenant, per-project revision receipt. */
export const projectAgentGuidanceVersionStore = {
  async lock(tx: PoolClient, projectItemId: string): Promise<void> {
    await tx.query(
      `INSERT INTO project_agent_guidance_versions (project_item_id) VALUES ($1)
       ON CONFLICT (tenant_id, project_item_id) DO NOTHING`,
      [projectItemId],
    );
    const result = await tx.query<{ project_item_id: string }>(
      `SELECT project_item_id FROM project_agent_guidance_versions
       WHERE tenant_id = app_tenant_default() AND project_item_id = $1 FOR UPDATE`,
      [projectItemId],
    );
    requireSingleRow(result.rows, "guidance revision receipt");
  },

  async propose(tx: PoolClient, projectItemId: string, current: Date | null): Promise<Date> {
    const result = await tx.query<{ last_version: Date }>(
      `SELECT GREATEST(
         date_trunc('milliseconds', clock_timestamp()),
         date_trunc('milliseconds', last_version) + interval '1 millisecond',
         date_trunc('milliseconds', $2::timestamptz) + interval '1 millisecond'
       ) AS last_version FROM project_agent_guidance_versions
       WHERE tenant_id = app_tenant_default() AND project_item_id = $1
      `,
      [projectItemId, current],
    );
    return requireSingleRow(result.rows, "guidance next revision").last_version;
  },

  async record(tx: PoolClient, projectItemId: string, version: Date): Promise<void> {
    const result = await tx.query(
      `UPDATE project_agent_guidance_versions SET last_version = $2
       WHERE tenant_id = app_tenant_default() AND project_item_id = $1`,
      [projectItemId, version],
    );
    requireAffectedRows(result, "guidance recorded revision");
  },

  async next(tx: PoolClient, projectItemId: string, current: Date | null): Promise<Date> {
    const version = await this.propose(tx, projectItemId, current);
    await this.record(tx, projectItemId, version);
    return version;
  },

  async remember(tx: PoolClient, projectItemId: string, current: Date): Promise<void> {
    const result = await tx.query(
      `UPDATE project_agent_guidance_versions SET last_version = GREATEST(last_version, $2::timestamptz)
       WHERE tenant_id = app_tenant_default() AND project_item_id = $1`,
      [projectItemId, current],
    );
    requireAffectedRows(result, "guidance remembered revision");
  },
};
