import type { PoolClient } from "pg";
import { listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import { heartbeatRuleSchema, type HeartbeatRule } from "../scheduler/rule.js";

export interface ManifestProperty {
  key: string;
  name: string;
  owner: "user" | "system";
  locked: boolean;
}

export interface ManifestDatabase {
  databaseId: string;
  name: string;
  schemaLocked: boolean;
  properties: ManifestProperty[];
}

export interface ManifestHeartbeat {
  id: string;
  name: string;
  actionId: string;
  rule: HeartbeatRule;
}

/**
 * Explicit, whole-project autonomy grants — checked at call time by the relevant choke point
 * (currently only `email.send`, mail/send.ts), never by the agent itself. `autonomous: false`
 * is the default for every project unless a human has directly set
 * `Projects.emailSendAutonomous` (issue #95) — that property is `owner: 'system'` with no
 * declared writer, deliberately: granting it is a project-level authorization decision, not
 * something exposed to the generic (agent-reachable) item-update path.
 */
export interface ManifestCapabilities {
  email: { send: { autonomous: boolean } };
}

export interface PermissionManifest {
  projectItemId: string;
  databases: ManifestDatabase[];
  heartbeats: ManifestHeartbeat[];
  capabilities: ManifestCapabilities;
}

/**
 * Computed synchronously from current schema state, scoped to one project (small,
 * indexed queries — not a scan of the whole system). Never persistently cached: this
 * is called fresh at the start of every agent_run.
 */
export async function generatePermissionManifest(client: PoolClient, projectItemId: string): Promise<PermissionManifest> {
  const { rows: databaseRows } = await client.query<{ id: string; name: string; schema_locked: boolean }>(
    `SELECT id, name, schema_locked FROM databases WHERE owner_project_item_id = $1 AND archived_at IS NULL`,
    [projectItemId],
  );

  const databases: ManifestDatabase[] = [];
  for (const db of databaseRows) {
    const properties = await listPropertiesByDatabase(client, db.id);
    databases.push({
      databaseId: db.id,
      name: db.name,
      schemaLocked: db.schema_locked,
      properties: properties.map((p) => ({ key: p.key, name: p.name, owner: p.owner, locked: p.locked })),
    });
  }

  const { rows: heartbeatRows } = await client.query<{ id: string; name: string; action_id: string; rule: unknown }>(
    `SELECT id, name, action_id, rule FROM project_heartbeats WHERE project_item_id = $1`,
    [projectItemId],
  );
  const heartbeats = heartbeatRows.map((h) => ({
    id: h.id,
    name: h.name,
    actionId: h.action_id,
    rule: heartbeatRuleSchema.parse(h.rule),
  }));

  const { rows: projectRows } = await client.query<{ properties: Record<string, unknown> }>(`SELECT properties FROM items WHERE id = $1`, [
    projectItemId,
  ]);
  const projectProperties = projectRows[0]?.properties ?? {};
  const capabilities: ManifestCapabilities = {
    email: { send: { autonomous: projectProperties.emailSendAutonomous === true } },
  };

  return { projectItemId, databases, heartbeats, capabilities };
}
