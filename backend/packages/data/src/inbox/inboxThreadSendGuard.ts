import { DatabaseError, type PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { lockItemByIdNowait } from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { ConflictError, ProposalLockedError, ValidationError } from "../errors.js";
import { INBOX_MODULE_ID, PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { lockInboxSourceIfPresent } from "./inboxSourceGuard.js";
import { LOCKED_PROPOSAL_STATUSES } from "./inboxTypesStore.js";

export async function guardInboxThreadSend(
  client: PoolClient,
  inboxItemId: string,
  proposalId?: string,
): Promise<void> {
  if (!(await lockInboxSourceIfPresent(client, inboxItemId))) {
    throw new ValidationError("Invalid Inbox subject", { field: "subject" });
  }
  const inbox = await getDatabaseByModuleId(client, INBOX_MODULE_ID);
  const proposals = await getDatabaseByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID);
  if (!inbox) throw new ValidationError("Invalid Inbox subject", { field: "subject" });
  if (!proposals) {
    if (proposalId) throw new ValidationError("Invalid Inbox subject", { field: "subject" });
    return;
  }
  const property = await getPropertyByKey(client, proposals.id, "sourceInbox");
  const definition = property ? await getRelationDefinitionByPropertyId(client, property.id) : null;
  if (!definition) {
    if (proposalId) throw new ValidationError("Invalid Inbox subject", { field: "subject" });
    return;
  }
  const edges = await listRelationsForItem(client, definition.id, inboxItemId);
  const ids = [...new Set(edges.map((edge) => otherSide(edge, inboxItemId)))].sort();
  const liveIds = new Set<string>();
  let decided = false;
  for (const id of ids) {
    await client.query("SAVEPOINT semp_proposal_lock");
    let card;
    try {
      card = await lockItemByIdNowait(client, proposals.id, id);
      await client.query("RELEASE SAVEPOINT semp_proposal_lock");
    } catch (error) {
      try {
        await client.query("ROLLBACK TO SAVEPOINT semp_proposal_lock");
        await client.query("RELEASE SAVEPOINT semp_proposal_lock");
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Proposal reservation and savepoint cleanup failed", {
          // Preserve the admission error as cause and the cleanup error as the second member.
          // eslint-disable-next-line preserve-caught-error
          cause: error,
        });
      }
      if (error instanceof DatabaseError && error.code === "55P03") {
        throw new ConflictError("Inbox proposal is busy", { field: "subject" });
      }
      throw error;
    }
    if (!card || card.deletedAt !== null) continue;
    liveIds.add(id);
    if (typeof card.properties.status === "string" && LOCKED_PROPOSAL_STATUSES.has(card.properties.status)) {
      decided = true;
    }
  }
  if (proposalId && !liveIds.has(proposalId)) throw new ValidationError("Invalid Inbox subject", { field: "subject" });
  if (decided) throw new ProposalLockedError();
}
