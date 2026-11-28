import type { Pool, PoolClient } from "pg";
import { CORE_TASK_NAMES, enqueueJob } from "@alldots/queue";
import { currentTenantScope } from "@alldots/shared";
import { z } from "zod";
import { requireManagedTransaction, withTransaction } from "../db/pool.js";
import type { ActionContext, ActionHandler } from "../scheduler/actions.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { EMAILS_RELATION_CONTEXT } from "./emailsRelationContext.js";
import { getMailMessageMetaByItemId, type MailEnvelope } from "./mailMessageMetaStore.js";
import {
  lookupPersonIdByEmail,
  normalizeEmailAddress,
  reindexPersonEmailsWithClaims,
} from "./personEmailIndexStore.js";
import { parseAddressListProperty } from "./addressListParsing.js";

import { MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID, MAIL_REINDEX_PERSON_EMAILS_ACTION_ID } from "./personLinkingKeys.js";

export { MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID, MAIL_REINDEX_PERSON_EMAILS_ACTION_ID } from "./personLinkingKeys.js";

const personEmailReindexActionConfigSchema = z.object({ peopleDatabaseId: z.string().min(1) });

export type PersonEmailReindexActionConfig = z.infer<typeof personEmailReindexActionConfigSchema>;

/**
 * `onItemEvent` action on People keeping `person_email_index` in sync. Deterministic index maintenance;
 * a conflicting claim is an expected outcome and is skipped, not reported as a failure.
 */
export function createPersonEmailReindexAction(pool: Pool): ActionHandler {
  return async (actionConfig: Record<string, unknown>, context: ActionContext) => {
    if (!context.itemId) return;
    const parsed = personEmailReindexActionConfigSchema.safeParse(actionConfig);
    if (!parsed.success) {
      throw new Error(`Malformed action config for ${MAIL_REINDEX_PERSON_EMAILS_ACTION_ID}: ${parsed.error.message}`);
    }
    const config: PersonEmailReindexActionConfig = parsed.data;
    await withTransaction(pool, async (client) => {
      const person = await itemsStore.getItemById(client, config.peopleDatabaseId, context.itemId as string);
      if (!person || person.deletedAt) return;
      const addresses = parseAddressListProperty(person.properties.emails);
      const { claimed } = await reindexPersonEmailsWithClaims(client, person.id, addresses);
      if (claimed.length > 0) {
        await enqueueJob(
          client,
          CORE_TASK_NAMES.MAIL_LINK_PERSON_EMAILS,
          { personId: person.id, addresses: claimed },
          {
            jobKey: `mail-link-person-emails:${person.id}`,
          },
        );
      }
    });
  };
}

const linkEmailToPeopleActionConfigSchema = z.object({
  emailsDatabaseId: z.string().min(1),
  senderPeopleKey: z.string().min(1),
  recipientsPeopleKey: z.string().min(1),
});

export type LinkEmailToPeopleActionConfig = z.infer<typeof linkEmailToPeopleActionConfigSchema>;

export interface LinkEmailEnvelopeToPeopleInput {
  itemId: string;
  envelope: MailEnvelope;
  emailsDatabaseId: string;
  senderPeopleKey: string;
  recipientsPeopleKey: string;
}

/** Locks a live message under the participating sender-writer transaction contract. */
async function lockEmailForPeopleLink(client: PoolClient, databaseId: string, itemId: string): Promise<boolean> {
  requireManagedTransaction(client);
  const scope = currentTenantScope();
  const { rows } = await client.query<{ isolation: string; tenant: string | null }>(
    "SELECT current_setting('transaction_isolation') AS isolation, app_current_tenant()::text AS tenant",
  );
  if (scope?.kind !== "tenant" || rows[0]?.isolation !== "read committed" || rows[0]?.tenant !== scope.tenantId) {
    throw new Error("Mail people linking requires a READ COMMITTED tenant transaction");
  }
  const item = await itemsStore.lockItemById(client, databaseId, itemId);
  return item !== null && item.deletedAt === null;
}

/**
 * Runs inside the caller's transaction (ingest heartbeat, `sendDraftEmail` finalization, historical
 * linking job). Existing edges of the locked message are checked first: an existing sender is retained
 * and already-linked recipients are skipped.
 */
export async function linkEmailEnvelopeToPeople(
  client: PoolClient,
  input: LinkEmailEnvelopeToPeopleInput,
): Promise<void> {
  if (!(await lockEmailForPeopleLink(client, input.emailsDatabaseId, input.itemId))) return;
  const senderProperty = await propertiesStore.getPropertyByKey(client, input.emailsDatabaseId, input.senderPeopleKey);
  const recipientsProperty = await propertiesStore.getPropertyByKey(
    client,
    input.emailsDatabaseId,
    input.recipientsPeopleKey,
  );

  if (senderProperty && input.envelope.from) {
    const personId = await lookupPersonIdByEmail(client, input.envelope.from.address);
    if (personId) {
      const definition = await relationsStore.getRelationDefinitionByPropertyId(client, senderProperty.id);
      if (!definition) throw new Error("Missing senderPeople relation definition");
      const existing = await relationsStore.listRelationsForItem(client, definition.id, input.itemId);
      if (existing.length === 0) {
        await createRelationWithClient(
          client,
          { relationPropertyId: senderProperty.id, callerItemId: input.itemId, targetItemId: personId },
          EMAILS_RELATION_CONTEXT,
        );
      }
    }
  }

  if (recipientsProperty) {
    const definition = await relationsStore.getRelationDefinitionByPropertyId(client, recipientsProperty.id);
    if (!definition) throw new Error("Missing recipientsPeople relation definition");
    const existing = await relationsStore.listRelationsForItem(client, definition.id, input.itemId);
    const linked = new Set(existing.map((edge) => relationsStore.otherSide(edge, input.itemId)));
    const recipients = [...(input.envelope.to ?? []), ...(input.envelope.cc ?? []), ...(input.envelope.bcc ?? [])];
    const seen = new Set<string>();
    for (const recipient of recipients) {
      const normalized = normalizeEmailAddress(recipient.address);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      const personId = await lookupPersonIdByEmail(client, normalized);
      if (personId && !linked.has(personId)) {
        await createRelationWithClient(
          client,
          { relationPropertyId: recipientsProperty.id, callerItemId: input.itemId, targetItemId: personId },
          EMAILS_RELATION_CONTEXT,
        );
        linked.add(personId);
      }
    }
  }
}

/**
 * `onItemEvent` ('create') action on Emails: links the envelope (committed with the item) through a plain
 * index lookup. An unmatched address leaves the relation unfilled; this is not a propose/confirm path.
 */
export function createLinkEmailToPeopleAction(pool: Pool): ActionHandler {
  return async (actionConfig: Record<string, unknown>, context: ActionContext) => {
    if (!context.itemId) return;
    const parsed = linkEmailToPeopleActionConfigSchema.safeParse(actionConfig);
    if (!parsed.success) {
      throw new Error(`Malformed action config for ${MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID}: ${parsed.error.message}`);
    }
    const config: LinkEmailToPeopleActionConfig = parsed.data;
    await withTransaction(pool, async (client) => {
      const meta = await getMailMessageMetaByItemId(client, context.itemId as string);
      if (!meta) return;
      await linkEmailEnvelopeToPeople(client, {
        itemId: context.itemId as string,
        envelope: meta.envelope,
        emailsDatabaseId: config.emailsDatabaseId,
        senderPeopleKey: config.senderPeopleKey,
        recipientsPeopleKey: config.recipientsPeopleKey,
      });
    });
  };
}

export { createNewEmailAgentRunDependencies } from "./newEmailAgentRun.js";
