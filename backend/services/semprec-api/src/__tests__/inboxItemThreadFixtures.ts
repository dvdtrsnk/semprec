import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  claimSempMessage,
  createChokePoint,
  createItemWithClient,
  createRelationWithClient,
  finishSempMessageTurn,
  getDatabaseByModuleId,
  sendSempMessage,
  seedSystem,
  updateItemWithClient,
  withTransaction,
} from "@semprec/data";

/**
 * Inbox item thread reply fixtures: an Inbox item with a processing proposal card, a reply played to the state the
 * retry or regeneration needs, and the proposal's decision. Only the reply's turn is played by hand.
 */

export interface InboxProposalFixture {
  sourceId: string;
  cardId: string;
  proposalsDatabaseId: string;
}

export async function createInboxProposalFixture(pool: Pool, tenantId: string): Promise<InboxProposalFixture> {
  await runInTenant(tenantId, () => seedSystem(pool));
  return runInTenant(tenantId, async () => {
    const { inbox, proposals } = await withTransaction(pool, async (client) => ({
      inbox: await getDatabaseByModuleId(client, "inbox"),
      proposals: await getDatabaseByModuleId(client, "processingProposals"),
    }));
    if (!inbox || !proposals) throw new Error("Missing seeded Inbox databases");
    const sourceProperty = (await createChokePoint(pool).listProperties(proposals.id)).find(
      (property) => property.key === "sourceInbox",
    );
    if (!sourceProperty) throw new Error("Missing sourceInbox property");
    return withTransaction(pool, async (client) => {
      const source = await createItemWithClient(client, {
        databaseId: inbox.id,
        properties: { date: "2026-01-01", time: "12:00", text: "source" },
      });
      const card = await createItemWithClient(
        client,
        {
          databaseId: proposals.id,
          properties: { kind: "inbox", fingerprint: randomUUID(), proposal: {}, history: [], status: "pending" },
        },
        { allowedSystemKeys: ["kind", "fingerprint", "proposal", "history", "status"] },
      );
      await createRelationWithClient(
        client,
        { relationPropertyId: sourceProperty.id, callerItemId: card.id, targetItemId: source.id },
        { ownerProcess: "processingProposals" },
      );
      return { sourceId: source.id, cardId: card.id, proposalsDatabaseId: proposals.id };
    });
  });
}

/** As a confirmation does: the status becomes `confirmed`, which locks the item thread. */
export async function decideInboxProposal(pool: Pool, tenantId: string, fixture: InboxProposalFixture): Promise<void> {
  await runInTenant(tenantId, () =>
    withTransaction(pool, async (client) => {
      await updateItemWithClient(
        client,
        { databaseId: fixture.proposalsDatabaseId, itemId: fixture.cardId, propertiesPatch: { status: "confirmed" } },
        { allowedSystemKeys: ["status"] },
      );
    }),
  );
}

export interface PlayedItemReply {
  threadId: string;
  userMessageId: string;
  assistantMessageId: string;
}

export async function playItemThreadReply(
  pool: Pool,
  tenantId: string,
  fixture: InboxProposalFixture,
  outcome: "error" | "done",
): Promise<PlayedItemReply> {
  return runInTenant(tenantId, () =>
    withTransaction(pool, async (client) => {
      const sent = await sendSempMessage(client, {
        subject: { inboxItemId: fixture.sourceId },
        text: "Question",
        context: [],
        hasContext: false,
      });
      expectClaimed(await claimSempMessage(client, sent.threadId, sent.assistantMessageId));
      const finished =
        outcome === "error"
          ? await finishSempMessageTurn(client, sent.assistantMessageId, { status: "error", errorCode: "modelError" })
          : await finishSempMessageTurn(client, sent.assistantMessageId, {
              status: "done",
              text: "Answer",
              // This reply has no run, so the id only has to be a valid bigint.
              lastEventId: "1",
              summary: { steps: [], durationMs: 100, tokens: { input: 1, output: 1 }, changes: [] },
            });
      if (!finished) throw new Error("The reply was not finished");
      return { threadId: sent.threadId, userMessageId: sent.messageId, assistantMessageId: sent.assistantMessageId };
    }),
  );
}

function expectClaimed(claimed: boolean): void {
  if (!claimed) throw new Error("The reply was not claimed");
}
