import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import type { ClassifiedAttachment } from "../mail/attachments.js";
import { ensureFolderItem } from "../mail/folderDiscovery.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";

export const USER = { writerKind: "user" } as const;
export const AGENT = { writerKind: "agent" } as const;
export const OWN_ADDRESS = "me@example.test";

/**
 * A seeded tenant of the mail module with one mailbox, and helpers that act in it through the production writers: a
 * message that arrives with attachments through the sync writer (`ingestEmailMessage`), items and relation edges written as
 * a user, and reads of edges and value links (issues gh-1898 and gh-1922). `tenantId` must be seeded with `seedSystem`.
 * Every helper runs in the tenant scope of `tenantId` on `runtime`, a pool of the runtime role.
 */
/** A message that arrived through the sync writer: its thread, the Threads item of the thread and the files it brought. */
export interface ReceivedMessage {
  threadId: string;
  itemId: string;
  emailItemId: string;
  fileIds: string[];
}

export type ValueLinks =
  Awaited<ReturnType<ChokePoint["getValueLinksForItems"]>> extends Map<string, infer V> ? V : never;

/** One tenant's ids and the helpers that act in it. */
export interface MailAttachmentWorld {
  tenantId: string;
  cp: ChokePoint;
  databases: Record<string, string>;
  properties: {
    threadProject: string;
    threadAttachments: string;
    filesProjects: string;
    emailFolder: string;
    emailAttachments: string;
  };
  inbox: { mailboxId: string; folderId: string; draftsFolderId: string };
  receive(messageId: string, options?: { attachments?: string[]; references?: string[] }): Promise<ReceivedMessage>;
  newItem(databaseKey: string, itemProperties: Record<string, unknown>): Promise<string>;
  link(
    relationPropertyId: string,
    callerItemId: string,
    targetItemId: string,
    writer?: typeof USER | typeof AGENT,
  ): Promise<void>;
  unlink(relationPropertyId: string, callerItemId: string, targetItemId: string): Promise<void>;
  related(relationPropertyId: string, itemId: string): Promise<string[]>;
  linksOf(itemId: string): Promise<ValueLinks>;
}

/** Consumes each attachment stream, so the write completes as a real storage write does. */
export function recordingStorage(written: string[] = []): BlobStorageWriter {
  return {
    async writeStream(storageKey: string, source: Readable) {
      written.push(storageKey);
      let byteSize = 0;
      for await (const chunk of source) byteSize += Buffer.byteLength(chunk);
      return { byteSize, contentHash: randomUUID() };
    },
    async delete() {},
    readStream() {
      throw new Error("readStream is not used by this test");
    },
  };
}

export function classifiedAttachment(filename: string): ClassifiedAttachment {
  return {
    filename,
    contentType: "application/octet-stream",
    contentId: null,
    disposition: "attachment",
    openStream: () => Readable.from([filename]),
  };
}

export async function setupMailAttachmentWorld(runtime: Pool, tenantId: string): Promise<MailAttachmentWorld> {
  const cp = createChokePoint(runtime);
  const inTenant = <T>(fn: () => Promise<T>) => runInTenant(tenantId, fn);
  const databases = Object.fromEntries(
    (await inTenant(() => cp.listDatabases())).flatMap((database) =>
      database.ownerModuleId ? [[database.ownerModuleId, database.id]] : [],
    ),
  );
  const databaseId = (key: string): string => {
    const id = databases[key];
    if (!id) throw new Error(`the ${key} database is not seeded`);
    return id;
  };
  const propertyId = async (databaseKey: string, key: string): Promise<string> => {
    const property = (await inTenant(() => cp.listProperties(databaseId(databaseKey)))).find(
      (entry) => entry.key === key,
    );
    if (!property) throw new Error(`the ${databaseKey}.${key} property is not seeded`);
    return property.id;
  };
  const properties = {
    threadProject: await propertyId("threads", "project"),
    threadAttachments: await propertyId("threads", "attachments"),
    filesProjects: await propertyId("files", "projects"),
    emailFolder: await propertyId("emails", "folder"),
    emailAttachments: await propertyId("emails", "attachments"),
  };
  const folderMailbox = await propertyId("folders", "mailbox");
  const inbox = await inTenant(() =>
    withTransaction(runtime, async (client) => {
      const mailbox = await createItemWithClient(client, {
        databaseId: databaseId("mailboxes"),
        properties: { name: "Personal", provider: "gmail" },
      });
      await writeMailboxAddresses(client, {
        mailboxesDatabaseId: databaseId("mailboxes"),
        mailboxItemId: mailbox.id,
        address: OWN_ADDRESS,
      });
      const folder = (providerId: string, name: string, specialPurpose: string) =>
        ensureFolderItem(client, {
          foldersDatabaseId: databaseId("folders"),
          mailboxItemId: mailbox.id,
          mailboxRelationPropertyId: folderMailbox,
          providerId,
          name,
          behavior: "folder",
          specialPurpose,
        });
      return {
        mailboxId: mailbox.id,
        folderId: await folder("INBOX", "Inbox", "inbox"),
        draftsFolderId: await folder("DRAFTS", "Drafts", "drafts"),
      };
    }),
  );
  const related = async (relationPropertyId: string, itemId: string): Promise<string[]> =>
    ((await inTenant(() => cp.listItemRelations(itemId, relationPropertyId))) ?? [])
      .map((edge) => edge.targetItemId)
      .sort();
  return {
    tenantId,
    cp,
    databases,
    properties,
    inbox,
    related,
    async receive(messageId, options = {}) {
      const references = options.references ?? [];
      const { itemId: emailItemId } = await inTenant(() =>
        withTransaction(runtime, (client) =>
          ingestEmailMessage(client, {
            emailsDatabaseId: databaseId("emails"),
            filesDatabaseId: databaseId("files"),
            folderRelationPropertyId: properties.emailFolder,
            attachmentsRelationPropertyId: properties.emailAttachments,
            mailboxItemId: inbox.mailboxId,
            folderItemId: inbox.folderId,
            messageId,
            inReplyTo: references.at(-1) ?? null,
            references,
            subject: `Subject of ${messageId}`,
            bodyText: `body of ${messageId}`,
            envelope: { from: { name: "Klient", address: "klient@example.test" }, to: [{ address: OWN_ADDRESS }] },
            attachments: (options.attachments ?? []).map(classifiedAttachment),
            storage: recordingStorage(),
            storageKeyPrefix: "thread-attachment-project",
          }),
        ),
      );
      const { rows } = await inTenant(() =>
        runtime.query<{ id: string; item_id: string }>(
          `SELECT t.id, t.item_id FROM mail_message_meta m JOIN mail_threads t ON t.id = m.thread_id WHERE m.item_id = $1`,
          [emailItemId],
        ),
      );
      const row = rows[0];
      if (!row) throw new Error("the ingested message has no thread item");
      return {
        threadId: row.id,
        itemId: row.item_id,
        emailItemId,
        fileIds: await related(properties.emailAttachments, emailItemId),
      };
    },
    async newItem(databaseKey, itemProperties) {
      return (await inTenant(() => cp.createItem({ databaseId: databaseId(databaseKey), properties: itemProperties })))
        .id;
    },
    async link(relationPropertyId, callerItemId, targetItemId, writer = USER) {
      await inTenant(() => cp.createRelation({ relationPropertyId, callerItemId, targetItemId }, writer));
    },
    async unlink(relationPropertyId, callerItemId, targetItemId) {
      await inTenant(() => cp.deleteRelation({ relationPropertyId, callerItemId, targetItemId }, USER));
    },
    async linksOf(itemId) {
      return (await inTenant(() => cp.getValueLinksForItems([itemId]))).get(itemId) ?? {};
    },
  };
}
