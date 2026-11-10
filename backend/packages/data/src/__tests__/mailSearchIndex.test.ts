import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { LocalFsBlobStorageWriter } from "../mail/blobStorage.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { searchItems } from "../mail/search.js";
import { buildItemSearchQuery } from "../search/itemSearchQuery.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let directory: string;
beforeAll(async () => {
  admin = getTestPool();
  pool = await createRuntimeRolePool(admin, "semprec_data");
  directory = await mkdtemp(join(tmpdir(), "mail-search-index-"));
});
beforeEach(async () => {
  await resetDatabase(admin);
  tenant = getTenantZeroId();
  await runInTenant(tenant, () => seedSystem(pool));
});
afterAll(async () => {
  await pool.end();
  await admin.end();
  await rm(directory, { recursive: true, force: true });
});

function pdf(text: string): Buffer {
  const objects = [
    "",
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 300 300] /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 24 Tf 20 100 Td (${text}) Tj ET`;
  objects.push(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
  let body = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = Buffer.byteLength(body, "latin1");
    body += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, "latin1");
  body += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  return Buffer.from(`${body}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`, "latin1");
}

describe("mail search at ingest", () => {
  it("indexes sender, subject, body and real PDF text, and handles an absent sender", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(pool);
      const getDb = async (key: string): Promise<string> => {
        const db = await withTransaction(pool, (client) => getDatabaseByModuleId(client, key));
        if (!db) throw new Error(`Missing database ${key}`);
        return db.id;
      };
      const emails = await getDb("emails");
      const folders = await getDb("folders");
      const files = await getDb("files");
      const props = await cp.listProperties(emails);
      const folderProperty = props.find((p) => p.key === "folder");
      const attachmentsProperty = props.find((p) => p.key === "attachments");
      if (!folderProperty || !attachmentsProperty) throw new Error("Missing email relations");
      const folder = await withTransaction(pool, (client) =>
        createItemWithClient(
          client,
          { databaseId: folders, properties: { name: "INBOX" } },
          { allowedSystemKeys: ["name"] },
        ),
      );
      const storage = new LocalFsBlobStorageWriter(directory);
      const common = {
        emailsDatabaseId: emails,
        filesDatabaseId: files,
        folderRelationPropertyId: folderProperty.id,
        attachmentsRelationPropertyId: attachmentsProperty.id,
        folderItemId: folder.id,
        mailboxItemId: randomUUID(),
        storage,
        storageKeyPrefix: "search",
      };
      const message = await withTransaction(pool, (client) =>
        ingestEmailMessage(client, {
          ...common,
          messageId: "<search-sender@example.test>",
          subject: "Subjectneedle",
          bodyText: "Bodyneedle",
          envelope: { from: { name: "Petr Novák", address: "petr@example.com" } },
          attachments: [
            {
              filename: "invoice.pdf",
              contentType: "application/pdf",
              contentId: null,
              disposition: "attachment",
              openStream: () => Readable.from(pdf("Pdfneedle")),
            },
          ],
        }),
      );
      const withoutSender = await withTransaction(pool, (client) =>
        ingestEmailMessage(client, {
          ...common,
          messageId: "<search-no-sender@example.test>",
          subject: "Senderlessneedle",
          envelope: {},
          attachments: [],
        }),
      );
      for (const [text, itemId] of [
        ["petr", message.itemId],
        ["novak", message.itemId],
        ["example.com", message.itemId],
        ["subjectneedle", message.itemId],
        ["bodyneedle", message.itemId],
        ["pdfneedle", message.itemId],
        ["senderlessneedle", withoutSender.itemId],
      ]) {
        if (!text || !itemId) throw new Error("Missing search fixture");
        const query = buildItemSearchQuery(text, 2);
        // The SQL fragment is constructed solely from validated bind positions; user text is bound separately.
        const { rows } = await withTransaction(pool, (client) =>
          client.query<{ matched: boolean }>(
            `SELECT search_vector @@ ${query.sql} AS matched FROM item_search_index WHERE item_id = $1`,
            [itemId, ...query.params],
          ),
        );
        expect(rows[0]?.matched, text).toBe(true);
      }
      const mailHits = await withTransaction(pool, (client) =>
        searchItems(client, { databaseId: emails, query: "novak" }),
      );
      expect(mailHits.map((hit) => hit.itemId)).toContain(message.itemId);
      const domainHits = await withTransaction(pool, (client) =>
        searchItems(client, { databaseId: emails, query: "example.com" }),
      );
      expect(domainHits.map((hit) => hit.itemId)).toContain(message.itemId);
      const wrongDomainHits = await withTransaction(pool, (client) =>
        searchItems(client, { databaseId: emails, query: "other.example" }),
      );
      expect(wrongDomainHits.map((hit) => hit.itemId)).not.toContain(message.itemId);
      const wrongDomain = buildItemSearchQuery("other.example", 2);
      // The fragment contains only validated bind positions; the input is bound separately.
      const { rows: negative } = await withTransaction(pool, (client) =>
        client.query<{ matched: boolean }>(
          `SELECT search_vector @@ ${wrongDomain.sql} AS matched FROM item_search_index WHERE item_id = $1`,
          [message.itemId, ...wrongDomain.params],
        ),
      );
      expect(negative[0]?.matched).toBe(false);
    });
  });
});
