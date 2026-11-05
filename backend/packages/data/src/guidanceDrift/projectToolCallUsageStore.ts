import { parseToolEventPayload, type ProjectToolCallGroup, type ProjectToolCallUsageStore } from "@semprec/shared";
import type { PoolClient } from "pg";

const MAX_EVENTS = 1_000;
const MAX_EVENT_BYTES = 65_536;

export const projectToolCallUsageStore: ProjectToolCallUsageStore<PoolClient> = {
  async listProjectToolCallGroups(tx, projectItemId, since) {
    const result = await tx.query<{
      run_id: string;
      payload: unknown;
      too_large: boolean;
      database_name: string | null;
    }>(
      `SELECT e.agent_run_id AS run_id, CASE WHEN octet_length(e.payload::text) <= $4 THEN e.payload ELSE NULL END AS payload,
              octet_length(e.payload::text) > $4 AS too_large, COALESCE(d.name, d.key) AS database_name
       FROM agent_run_events e JOIN agent_runs r ON r.id = e.agent_run_id
       LEFT JOIN databases d ON d.id::text = e.payload->>'targetDatabaseId'
       WHERE r.project_item_id = $1 AND e.kind = 'tool_use' AND e.at >= $2 AND e.at <= $5
       ORDER BY e.at DESC, e.id DESC LIMIT $3`,
      [projectItemId, since, MAX_EVENTS + 1, MAX_EVENT_BYTES, new Date(since.getTime() + 14 * 24 * 60 * 60 * 1000)],
    );
    if (result.rows.length > MAX_EVENTS) throw new Error("Behavior drift event snapshot exceeds its limit");
    if (result.rows.some((row) => row.too_large)) throw new Error("Behavior drift event exceeds its size limit");
    const groups = new Map<string, { group: ProjectToolCallGroup; runs: Set<string> }>();
    for (const row of result.rows) {
      const event = parseToolEventPayload("tool_use", row.payload);
      if (!event || (!event.operation && !event.mcp)) continue;
      const databaseId = event.targetDatabaseId ?? null;
      const subject = event.operation
        ? { operation: event.operation, databaseId }
        : { mcpTool: event.mcp!.toolRegistrationId, databaseId };
      const key = JSON.stringify(subject);
      let value = groups.get(key);
      if (!value) {
        value = {
          group: {
            subject,
            databaseName: row.database_name,
            runIds: [],
            count: 0,
            ...(event.mcp ? { toolName: `${event.mcp.serverName}/${event.mcp.toolName}` } : {}),
          },
          runs: new Set(),
        };
        groups.set(key, value);
      }
      if (!value.runs.has(row.run_id)) {
        value.runs.add(row.run_id);
        if (value.group.runIds.length < 20) value.group.runIds.push(row.run_id);
        value.group.count += 1;
      }
    }
    return [...groups.values()].map(({ group }) => group);
  },
};
