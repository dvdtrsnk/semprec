import type { PoolClient } from "pg";
import { AGENT_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { tenantLane } from "../tenancy/tenantLane.js";

export async function enqueueSempMessage(
  client: PoolClient,
  payload: { threadId: string; assistantMessageId: string },
): Promise<void> {
  const queueName = tenantLane("semp-chat");
  if (!queueName) throw new Error("Semp message enqueue requires a tenant scope");
  await enqueueJob(client, AGENT_TASK_NAMES.SEMP_MESSAGE, payload, {
    queueName,
    maxAttempts: 1,
    priority: -1,
    jobKey: `sempMessage:${payload.assistantMessageId}`,
    jobKeyMode: "unsafe_dedupe",
  });
}
