import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { EMAILS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { parseAddressListProperty } from "./addressListParsing.js";
import { normalizeEmailAddress } from "./personEmailIndexStore.js";
import { linkEmailEnvelopeToPeople } from "./personLinkingActions.js";

const payloadSchema = z.object({ personId: z.uuid(), addresses: z.array(z.string()) }).strict();
const addressSchema = z.object({ address: z.string() });
const envelopeSchema = z.object({
  from: addressSchema.optional(),
  to: z.array(addressSchema).optional(),
  cc: z.array(addressSchema).optional(),
});
const PAGE_SIZE = 100;

/** Reconciles current index ownership, holding its rows through each page's edge writes. */
export async function handleMailLinkPersonEmailsTask(pool: Pool, payload: unknown): Promise<void> {
  const { personId } = payloadSchema.parse(payload);
  let after: string | null = null;
  for (;;) {
    const page = await withTransaction(pool, async (client) => {
      const person = await client.query<{ properties: Record<string, unknown> }>(
        `SELECT i.properties FROM items i JOIN databases d ON d.id = i.database_id
         WHERE i.id = $1 AND i.deleted_at IS NULL AND d.owner_module_id = 'people'`,
        [personId],
      );
      if (!person.rows[0]) return [];
      const owned = await client.query<{ email: string }>(
        `SELECT email FROM person_email_index WHERE item_id = $1 ORDER BY email FOR SHARE`,
        [personId],
      );
      const addresses = new Set(owned.rows.map((row) => row.email));
      if (addresses.size === 0) return [];
      const spellings = new Set(addresses);
      for (const value of parseAddressListProperty(person.rows[0].properties.emails)) {
        if (addresses.has(normalizeEmailAddress(value))) spellings.add(value);
      }
      const probes: string[] = [];
      for (const address of spellings) {
        probes.push(JSON.stringify({ from: { address } }));
        probes.push(JSON.stringify({ to: [{ address }] }));
        probes.push(JSON.stringify({ cc: [{ address }] }));
      }
      const emails = await getDatabaseByModuleId(client, EMAILS_MODULE_ID);
      if (!emails) return [];
      const rows = await client.query<{ item_id: string; envelope: unknown }>(
        `SELECT m.item_id, m.envelope FROM mail_message_meta m JOIN items i ON i.id = m.item_id
         WHERE i.database_id = $1 AND i.deleted_at IS NULL AND ($2::uuid IS NULL OR m.item_id > $2)
           AND m.envelope @> ANY($3::jsonb[]) ORDER BY m.item_id LIMIT $4`,
        [emails.id, after, probes, PAGE_SIZE],
      );
      for (const row of rows.rows) {
        const envelope = envelopeSchema.parse(row.envelope);
        const from =
          envelope.from && addresses.has(normalizeEmailAddress(envelope.from.address)) ? envelope.from : undefined;
        const to = (envelope.to ?? []).filter((entry) => addresses.has(normalizeEmailAddress(entry.address)));
        const cc = (envelope.cc ?? []).filter((entry) => addresses.has(normalizeEmailAddress(entry.address)));
        await linkEmailEnvelopeToPeople(client, {
          itemId: row.item_id,
          emailsDatabaseId: emails.id,
          envelope: { from, to, cc },
          senderPeopleKey: "senderPeople",
          recipientsPeopleKey: "recipientsPeople",
        });
      }
      return rows.rows.map((row) => row.item_id);
    });
    if (page.length < PAGE_SIZE) return;
    after = page[page.length - 1]!;
  }
}
