import type { PoolClient } from "pg";
import { requireAffectedRows, requireManagedTransaction } from "../db/pool.js";

export async function insertApprovalOutcomeSystemMessage(
  client: PoolClient,
  threadId: string,
  requestId: string,
  key: string,
  params: Record<string, string | number | null>,
): Promise<void> {
  requireManagedTransaction(client);
  const inserted = await client.query(
    `INSERT INTO semp_messages (thread_id, role, system_key, system_params, context)
     VALUES ($1, 'system', $2, $3::jsonb, $4::jsonb)`,
    [
      threadId,
      key,
      JSON.stringify(params),
      JSON.stringify([{ kind: "approvalRequest", approvalRequestId: requestId }]),
    ],
  );
  requireAffectedRows(inserted, "inserting approval outcome message");
  const result = await client.query(
    "UPDATE semp_threads SET last_activity_at = GREATEST(last_activity_at, now()) WHERE id = $1",
    [threadId],
  );
  requireAffectedRows(result, `updating thread '${threadId}' activity`);
}
