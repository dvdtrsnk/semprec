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

/** The thread properties a merge decides between the two threads' values. */
const THREAD_VALUE_KEYS = ["company", "project"] as const;

export interface ThreadMergeIds {
  /** The Threads items of the two threads. */
  winnerItemId: string;
  loserItemId: string;
  /** The `mail_threads` ids of the two threads. */
  winnerThreadId: string;
  loserThreadId: string;
}

/** What `planThreadValueMerge` decided, for `transferMailThreadRelationsWithClient` and `finishThreadValueMerge`. */
export interface ThreadValueMergePlan {
  /** The keys whose value the loser's edge takes over from the winner's edge. */
  loserValueWins: Set<string>;
  /** The keys whose loser link moves to the winner: those whose loser value ends up on the winner. */
  adopted: string[];
}

/**
 * Decides, for the `company` and for the `project` of two threads about to merge, whose value the merged thread
 * holds. A value is inherited when the thread's link for that property is `on`, and its own otherwise (a
 * `broken` link, or no link). The winner keeps its value, except that the loser's value replaces it when:
 * - the loser's is its own and the winner's is inherited, or
 * - both are of the same kind and the loser's `mail_threads.created_at` is older than the winner's.
 * A loser without a value decides nothing, and a winner without a value takes the loser's.
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
 * After the edges were transferred: the loser's links of the adopted keys move to the winner (replacing the winner's
 * own link for the key), every other link of the loser is deleted with it, and the rules that follow the winner's
 * project are queued through the propagation job, so what the winner's attachments inherit is recomputed.
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
