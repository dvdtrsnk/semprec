import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import type { ActionContext, ActionHandler } from "../scheduler/actions.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { createRelationWithClient } from "../chokePoint/chokePoint.js";
import { getMailMessageMetaByItemId } from "./mailMessageMetaStore.js";
import { lookupPersonIdByEmail, normalizeEmailAddress, reindexPersonEmails } from "./personEmailIndexStore.js";

export const MAIL_REINDEX_PERSON_EMAILS_ACTION_ID = "mail.reindexPersonEmails";
export const MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID = "mail.linkPeopleByEmail";

/** `People.emails` (issue #26) is free-form `longText`, one address per line — see seedEmailModule.ts for why no dedicated list property type was introduced for this. */
function parseEmailsProperty(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface PersonEmailReindexActionConfig {
  peopleDatabaseId: string;
}

/**
 * Registered as an `onItemEvent` ('create' and 'update') heartbeat action on the People
 * database: keeps `person_email_index` in sync with each Person's `emails` property. Pure
 * deterministic index maintenance (project goal, issue #21: no AI/agent layer involved) —
 * a conflicting claim (an address already owned by a different Person) is silently skipped,
 * not surfaced as a heartbeat failure, since "another person already owns this address" is
 * an expected, benign outcome, not an error condition.
 */
export function createPersonEmailReindexAction(pool: Pool): ActionHandler {
  return async (actionConfig: Record<string, unknown>, context: ActionContext) => {
    if (!context.itemId) return;
    const config = actionConfig as unknown as PersonEmailReindexActionConfig;
    await withTransaction(pool, async (client) => {
      const person = await itemsStore.getItemById(client, config.peopleDatabaseId, context.itemId as string);
      if (!person || person.deletedAt) return;
      const addresses = parseEmailsProperty(person.properties.emails);
      await reindexPersonEmails(client, person.id, addresses);
    });
  };
}

export interface LinkEmailToPeopleActionConfig {
  emailsDatabaseId: string;
  senderPeopleKey: string;
  recipientsPeopleKey: string;
}

/**
 * Registered as an `onItemEvent` ('create') heartbeat action on the Emails database: reads
 * the just-ingested message's envelope (`mail_message_meta`, already committed in the same
 * transaction as the Emails item — see mail/ingest.ts) and links `senderPeople`/
 * `recipientsPeople` via a plain `person_email_index` lookup. An unmatched address (most
 * messages) simply leaves the relation unfilled — not an error, not a proposal for AI to
 * confirm (this is deterministic index lookup, out of Semprec's propose/confirm path
 * entirely, per the issue's explicit scope).
 */
export function createLinkEmailToPeopleAction(pool: Pool): ActionHandler {
  return async (actionConfig: Record<string, unknown>, context: ActionContext) => {
    if (!context.itemId) return;
    const config = actionConfig as unknown as LinkEmailToPeopleActionConfig;
    await withTransaction(pool, async (client) => {
      const meta = await getMailMessageMetaByItemId(client, context.itemId as string);
      if (!meta) return;

      const senderProperty = await propertiesStore.getPropertyByKey(client, config.emailsDatabaseId, config.senderPeopleKey);
      const recipientsProperty = await propertiesStore.getPropertyByKey(client, config.emailsDatabaseId, config.recipientsPeopleKey);

      if (senderProperty && meta.envelope.from) {
        const personId = await lookupPersonIdByEmail(client, meta.envelope.from.address);
        if (personId) {
          await createRelationWithClient(client, { relationPropertyId: senderProperty.id, itemId: context.itemId as string, targetItemId: personId });
        }
      }

      if (recipientsProperty) {
        const recipients = [...(meta.envelope.to ?? []), ...(meta.envelope.cc ?? []), ...(meta.envelope.bcc ?? [])];
        const seen = new Set<string>();
        for (const recipient of recipients) {
          const normalized = normalizeEmailAddress(recipient.address);
          if (seen.has(normalized)) continue;
          seen.add(normalized);
          const personId = await lookupPersonIdByEmail(client, normalized);
          if (personId) {
            await createRelationWithClient(client, { relationPropertyId: recipientsProperty.id, itemId: context.itemId as string, targetItemId: personId });
          }
        }
      }
    });
  };
}
