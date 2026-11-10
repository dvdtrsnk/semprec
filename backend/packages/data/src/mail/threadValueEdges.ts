import type {
  RelationEdgeDeleteHook,
  RelationEdgeWriteHook,
  RelationEdgeWriteHookContext,
} from "../chokePoint/hooks.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { lockItemById, lockItemByIdNowait } from "../chokePoint/itemsStore.js";
import { getProperty } from "../chokePoint/propertiesStore.js";
import { listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { runValueLinkAdmissionLock } from "../chokePoint/valueLinkRelationAdmission.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { THREADS_MODULE_ID } from "../seed/emailModuleKeys.js";

const PROPOSED_CALLER = "00000000-0000-0000-0000-000000000000";
type EndpointContext = Pick<
  RelationEdgeWriteHookContext,
  "client" | "edgeContext" | "callerItemId" | "targetItemId" | "lockMode"
>;

/** Reserve canonical Threads endpoints before an incident relation mutation. */
async function reserveThreadEndpoints(context: EndpointContext, requireLive: boolean): Promise<string[]> {
  const { client, edgeContext, callerItemId, targetItemId, lockMode } = context;
  const threads = await getDatabaseByModuleId(client, THREADS_MODULE_ID);
  if (!threads?.system) return [];
  const endpoints = new Set<string>();
  if (edgeContext.property.databaseId === threads.id && callerItemId !== PROPOSED_CALLER) endpoints.add(callerItemId);
  if (edgeContext.targetDatabaseId === threads.id) endpoints.add(targetItemId);
  for (const id of [...endpoints].sort()) {
    const item =
      lockMode === "nowait"
        ? await runValueLinkAdmissionLock(() => lockItemByIdNowait(client, threads.id, id))
        : await lockItemById(client, threads.id, id);
    if (requireLive && (!item || item.deletedAt)) throw new NotFoundError("Thread item not found");
  }
  return [...endpoints];
}

export const threadValueEdgeWriteHook: RelationEdgeWriteHook = async (context) => {
  const endpoints = await reserveThreadEndpoints(context, true);
  if (!endpoints.length) return;
  const { client, edgeContext, callerItemId, targetItemId } = context;
  const threads = await getDatabaseByModuleId(client, THREADS_MODULE_ID);
  if (!threads) return;
  const oppositeId =
    edgeContext.reldef.propertyIdA === edgeContext.property.id
      ? edgeContext.reldef.propertyIdB
      : edgeContext.reldef.propertyIdA;
  const opposite = oppositeId ? await getProperty(client, oppositeId) : null;
  const property =
    edgeContext.property.databaseId === threads.id
      ? edgeContext.property
      : opposite?.databaseId === threads.id
        ? opposite
        : null;
  if (!property || (property.key !== "project" && property.key !== "company")) return;
  for (const id of endpoints) {
    const other = id === callerItemId ? targetItemId : callerItemId;
    const edges = await listRelationsForItem(client, edgeContext.reldef.id, id);
    if (edges.some((edge) => otherSide(edge, id) !== other))
      throw new ValidationError("Thread already has a different value", { field: property.key });
  }
};

export const threadValueEdgeDeleteHook: RelationEdgeDeleteHook = async (context) => {
  await reserveThreadEndpoints(context, false);
};
