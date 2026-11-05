import { randomUUID } from "node:crypto";
import {
  BEHAVIOR_DRIFT_INPUT_BYTES,
  BEHAVIOR_DRIFT_MIN_RUNS,
  BEHAVIOR_DRIFT_WINDOW_DAYS,
  fingerprintGuidanceDriftSubject,
  parseToolEventPayload,
  type ProjectToolCallGroup,
  type ProjectToolCallUsageStore,
} from "@semprec/shared";
import type { PoolClient } from "pg";

interface CandidateRow {
  run_id: string;
  payload: unknown;
  event_us: string;
  event_id: string;
  database_name: string | null;
}
interface Evidence {
  runId: string;
  micros: bigint;
  id: bigint;
}
interface CurrentGroup {
  key: string;
  group: ProjectToolCallGroup;
  lastRun: string | null;
  recent: Evidence[];
  latest: Evidence | null;
}
function newer(a: Evidence, b: Evidence): boolean {
  return a.micros > b.micros || (a.micros === b.micros && a.id > b.id);
}

export const projectToolCallUsageStore: ProjectToolCallUsageStore<PoolClient> = {
  async listProjectToolCallGroups(tx, projectItemId, since) {
    const cursor = `behavior_usage_${randomUUID().replaceAll("-", "")}`;
    const until = new Date(since.getTime() + BEHAVIOR_DRIFT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    await tx.query(
      `DECLARE ${cursor} NO SCROLL CURSOR WITHOUT HOLD FOR
       SELECT e.agent_run_id AS run_id, e.payload,
              (extract(epoch FROM e.at) * 1000000)::bigint::text AS event_us,
              e.id::text AS event_id, COALESCE(d.name, d.key) AS database_name
       FROM agent_run_events e JOIN agent_runs r ON r.id = e.agent_run_id
       LEFT JOIN databases d ON d.id::text = e.payload->>'targetDatabaseId'
       WHERE r.project_item_id = $1 AND e.kind = 'tool_use' AND e.at >= $2 AND e.at <= $3
       ORDER BY e.payload->>'operation' NULLS FIRST, e.payload#>>'{mcp,toolRegistrationId}' NULLS FIRST,
                e.payload->>'targetDatabaseId' NULLS FIRST, e.agent_run_id, e.at DESC, e.id DESC`,
      [projectItemId, since, until],
    );
    const groups: ProjectToolCallGroup[] = [];
    let current: CurrentGroup | null = null;
    let projectionBytes = 2;
    const finish = () => {
      if (!current || current.group.count < BEHAVIOR_DRIFT_MIN_RUNS) return;
      current.group.runIds = current.recent.map((entry) => entry.runId);
      const { subject, databaseName, count, toolName } = current.group;
      const projection = {
        fingerprint: fingerprintGuidanceDriftSubject(projectItemId, "behavior", subject),
        subject,
        databaseName,
        count,
        toolName,
      };
      projectionBytes += Buffer.byteLength(JSON.stringify(projection), "utf8") + (groups.length ? 1 : 0);
      if (projectionBytes > BEHAVIOR_DRIFT_INPUT_BYTES)
        throw new Error("Behavior drift comparison input exceeds its limit");
      groups.push(current.group);
    };
    let complete = false;
    try {
      for (;;) {
        const { rows } = await tx.query<CandidateRow>(`FETCH FORWARD 16 FROM ${cursor}`);
        if (!rows.length) break;
        for (const row of rows) {
          const event = parseToolEventPayload("tool_use", row.payload);
          if (!event || (!event.operation && !event.mcp)) continue;
          const databaseId = event.targetDatabaseId ?? null;
          const subject = event.operation
            ? { operation: event.operation, databaseId }
            : { mcpTool: event.mcp!.toolRegistrationId, databaseId };
          const key = JSON.stringify(subject);
          if (!current || current.key !== key) {
            finish();
            current = {
              key,
              group: { subject, databaseName: row.database_name, runIds: [], count: 0 },
              lastRun: null,
              recent: [],
              latest: null,
            };
          }
          if (current.lastRun === row.run_id) continue;
          current.lastRun = row.run_id;
          current.group.count += 1;
          if (!Number.isSafeInteger(current.group.count))
            throw new Error("Behavior drift run count exceeds safe integer range");
          const evidence = { runId: row.run_id, micros: BigInt(row.event_us), id: BigInt(row.event_id) };
          if (!current.latest || newer(evidence, current.latest)) {
            current.latest = evidence;
            current.group.databaseName = row.database_name;
            if (event.mcp) current.group.toolName = `${event.mcp.serverName}/${event.mcp.toolName}`;
          }
          current.recent.push(evidence);
          current.recent.sort((a, b) => (newer(a, b) ? -1 : newer(b, a) ? 1 : 0));
          if (current.recent.length > 20) current.recent.pop();
        }
      }
      finish();
      complete = true;
    } finally {
      if (complete) await tx.query(`CLOSE ${cursor}`);
    }
    return groups;
  },
};
