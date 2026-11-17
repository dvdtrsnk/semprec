import type { PoolClient } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem } from "../chokePoint/relationsStore.js";
import {
  deleteValueLinkOfProperty,
  deleteValueLinksByItemId,
  listValueLinksByItemIds,
  moveValueLinkToItem,
} from "../chokePoint/valueLinksStore.js";
import { scheduleDownstream } from "../valueLinks/linkPropagation.js";
import { THREADS_MODULE_ID } from "../seed/emailModuleKeys.js";

const THREAD_VALUE_KEYS = ["company", "project"] as const;

export interface ThreadMergeIds {
  winnerItemId: string;
  loserItemId: string;
  winnerThreadId: string;
  loserThreadId: string;
}

export interface ThreadValueMergePlan {
  /** Keys where the loser's edge takes over from the winner's. */
  loserValueWins: Set<string>;
  /** Keys whose loser link moves to the winner. */
  adopted: string[];
}

/**
 * A value is inherited when its link is `on`, otherwise the thread's own. The loser's value replaces
 * the winner's when the loser's is own and the winner's inherited, or both are of the same kind and the
 * loser thread is older. A winner without a value takes the loser's.
 */
export async function planThreadValueMerge(client: PoolClient, ids: ThreadMergeIds): Promise<ThreadValueMergePlan> {
  const threads = await getDatabaseByModuleId(client, THREADS_MODULE_ID);
  if (!threads) throw new Error("Threads database is missing");
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT id, created_at FROM mail_threads WHERE id = ANY($1::uuid[])`,
    [[ids.winnerThreadId, ids.loserThreadId]],
  );
  const createdAt = new Map(
    z
      .array(z.object({ id: z.uuid(), created_at: z.date() }))
      .parse(rows)
      .map((row) => [row.id, row.created_at.getTime()]),
  );
  const winnerCreated = createdAt.get(ids.winnerThreadId);
  const loserCreated = createdAt.get(ids.loserThreadId);
  if (winnerCreated === undefined || loserCreated === undefined) throw new Error("Invalid Threads merge binding");
  const links = await listValueLinksByItemIds(client, [ids.winnerItemId, ids.loserItemId]);
  const inherited = (itemId: string, key: string): boolean =>
    links.some((link) => link.itemId === itemId && link.propertyKey === key && link.state === "on");
  const plan: ThreadValueMergePlan = { loserValueWins: new Set(), adopted: [] };
  for (const key of THREAD_VALUE_KEYS) {
    const property = await getPropertyByKey(client, threads.id, key);
    const definition = property ? await getRelationDefinitionByPropertyId(client, property.id) : null;
    if (!definition) throw new Error(`Threads ${key} relation is missing`);
    if ((await listRelationsForItem(client, definition.id, ids.loserItemId)).length === 0) continue;
    if ((await listRelationsForItem(client, definition.id, ids.winnerItemId)).length === 0) {
      plan.adopted.push(key);
      continue;
    }
    const loserInherited = inherited(ids.loserItemId, key);
    const winnerInherited = inherited(ids.winnerItemId, key);
    const loserWins = loserInherited === winnerInherited ? loserCreated < winnerCreated : winnerInherited;
    if (!loserWins) continue;
    plan.loserValueWins.add(key);
    plan.adopted.push(key);
  }
  return plan;
}

/**
 * Runs after the edges were transferred. The loser's other links are deleted, and propagation is queued
 * so what the winner's attachments inherit is recomputed.
 */
export async function finishThreadValueMerge(
  client: PoolClient,
  plan: ThreadValueMergePlan,
  ids: Pick<ThreadMergeIds, "winnerItemId" | "loserItemId">,
): Promise<void> {
  for (const key of plan.adopted) {
    await deleteValueLinkOfProperty(client, ids.winnerItemId, key);
    await moveValueLinkToItem(client, { fromItemId: ids.loserItemId, toItemId: ids.winnerItemId, propertyKey: key });
  }
  await deleteValueLinksByItemId(client, ids.loserItemId);
  await scheduleDownstream(client, THREADS_MODULE_ID, "project", ids.winnerItemId, 1);
}
