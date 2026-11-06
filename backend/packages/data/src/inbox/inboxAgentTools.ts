import type { Pool } from "pg";
import { z } from "zod";
import { currentTenantScope } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { listInboxAttachments } from "./inboxAttachmentsStore.js";
import { parseStoredProposalEnvelope } from "./proposalEnvelope.js";
import { proposalHistoryEntrySchema } from "./proposalHistory.js";

export const inboxProposalGetArgsSchema = z.object({ proposalId: z.string().uuid() }).strict();
const notFound = { error: true, result: "Proposal not found" } as const;
const sourceSchema = z.object({ text: z.string().nullable().optional() }).passthrough();
const cardSchema = z
  .object({
    status: z.string(),
    userEditedKeys: z.array(z.string()).nullable().optional(),
    history: z.unknown().optional(),
    proposal: z.unknown().optional(),
  })
  .passthrough();

/** Read only the live card associated with the calling run's current Inbox thread. */
export function createInboxProposalGetTool(pool: Pool) {
  return async (runId: string, rawArgs: unknown): Promise<{ error: boolean; result: string }> => {
    const args = inboxProposalGetArgsSchema.safeParse(rawArgs);
    if (!args.success) return { error: true, result: "Invalid arguments" };
    if (!z.string().uuid().safeParse(runId).success || currentTenantScope()?.kind !== "tenant") return notFound;
    return withTransaction(pool, async (client) => {
      const association = await client.query<{ source_id: string; card_id: string }>(
        `SELECT source.id AS source_id, card.id AS card_id
           FROM agent_runs run
           JOIN semp_threads thread ON thread.tenant_id = run.tenant_id AND thread.id = run.thread_id AND thread.kind = 'item'
           JOIN items source ON source.tenant_id = thread.tenant_id AND source.id = thread.subject_inbox_item_id AND source.deleted_at IS NULL
           JOIN databases inbox ON inbox.tenant_id = source.tenant_id AND inbox.id = source.database_id AND inbox.owner_module_id = 'inbox'
           JOIN items card ON card.tenant_id = source.tenant_id AND card.id = $2 AND card.deleted_at IS NULL
           JOIN databases proposals ON proposals.tenant_id = card.tenant_id AND proposals.id = card.database_id AND proposals.owner_module_id = 'processingProposals'
           JOIN properties property ON property.tenant_id = proposals.tenant_id AND property.database_id = proposals.id AND property.key = 'sourceInbox'
           JOIN relation_definitions definition ON definition.tenant_id = property.tenant_id AND (definition.property_id_a = property.id OR definition.property_id_b = property.id)
           JOIN item_relations edge ON edge.tenant_id = definition.tenant_id AND edge.relation_definition_id = definition.id
             AND ((edge.item_a = source.id AND edge.item_b = card.id) OR (edge.item_b = source.id AND edge.item_a = card.id))
          WHERE run.tenant_id = app_current_tenant() AND run.id = $1`,
        [runId, args.data.proposalId],
      );
      const row = association.rows[0];
      if (!row) return notFound;
      const items = await getItemsByIds(client, [row.source_id, row.card_id]);
      const source = items.find((item) => item.id === row.source_id);
      const card = items.find((item) => item.id === row.card_id);
      if (!source || !card) return notFound;
      const sourceProperties = sourceSchema.parse(source.properties);
      const cardProperties = cardSchema.parse(card.properties);
      const attachments = await listInboxAttachments(client, [source.id]);
      const history = z.array(proposalHistoryEntrySchema).safeParse(cardProperties.history);
      return {
        error: false,
        result: JSON.stringify({
          captureText: sourceProperties.text ?? null,
          attachments: attachments.map((attachment) => ({ attachmentId: attachment.attachmentId, name: null })),
          envelope: parseStoredProposalEnvelope(cardProperties.proposal, card.id),
          userEditedKeys: cardProperties.userEditedKeys ?? [],
          status: cardProperties.status,
          history: history.success ? history.data : [],
        }),
      };
    });
  };
}
