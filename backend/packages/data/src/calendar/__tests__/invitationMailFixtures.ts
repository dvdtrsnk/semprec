import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import "../../domainWriteHooks.js";
import { createUser } from "../../auth/usersStore.js";
import { withTransaction } from "../../db/pool.js";
import type { BlobStorageWriter } from "../../mail/blobStorage.js";
import { ingestEmailMessage } from "../../mail/ingest.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  setupMailAttachmentWorld,
  type MailAttachmentWorld as World,
} from "../../testSupport/mailAttachmentFixtures.js";
import { createTestTenant } from "../../testSupport/testDb.js";
import { createInvitationIngestAction } from "../invitationIngestAction.js";
import { createRespondToInvitationRouteHandler } from "../invitationRouteHandlers.js";

/** The address the messages of `receive` come from unless a test names another one: the organizer of `ics`. */
export const ORGANIZER_ADDRESS = "olga@example.test";

/** A storage that keeps the bytes it was given, so the ingest reads back what mail ingest wrote. */
function memoryStorage(): BlobStorageWriter {
  const blobs = new Map<string, Buffer>();
  return {
    async writeStream(storageKey, source) {
      const chunks: Buffer[] = [];
      for await (const chunk of source) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      const bytes = Buffer.concat(chunks);
      blobs.set(storageKey, bytes);
      return { byteSize: bytes.length, contentHash: createHash("sha256").update(bytes).digest("hex") };
    },
    async delete(storageKey) {
      blobs.delete(storageKey);
    },
    readStream(storageKey) {
      const bytes = blobs.get(storageKey);
      if (!bytes) throw new Error(`No blob under ${storageKey}`);
      return Readable.from([bytes]);
    },
  };
}

export interface IcsOptions {
  method?: string;
  uid?: string;
  sequence?: number;
  /** `null` leaves SUMMARY out. */
  summary?: string | null;
  /** `null` leaves LOCATION out. */
  location?: string | null;
  dtStart?: string;
  /** `null` leaves DTEND out. */
  dtEnd?: string | null;
  /** The ORGANIZER line; defaults to the organizer `ORGANIZER_ADDRESS`. */
  organizer?: string;
}

/**
 * The text of an iMIP calendar part with one VEVENT. By default: "Sprint review" in "Room 4" on Thursday 22 Oct 2026,
 * 13:00-14:00 in Europe/Prague (11:00-12:00 UTC), organized by Olga.
 */
export function ics(options: IcsOptions = {}): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `METHOD:${options.method ?? "REQUEST"}`,
    "BEGIN:VEVENT",
    `UID:${options.uid ?? "sprint-review@example.test"}`,
    `SEQUENCE:${options.sequence ?? 0}`,
    ...(options.summary === null ? [] : [`SUMMARY:${options.summary ?? "Sprint review"}`]),
    ...(options.location === null ? [] : [`LOCATION:${options.location ?? "Room 4"}`]),
    options.dtStart ?? "DTSTART:20261022T110000Z",
    ...(options.dtEnd === null ? [] : [options.dtEnd ?? "DTEND:20261022T120000Z"]),
    options.organizer ?? `ORGANIZER;CN=Olga Organizer:mailto:${ORGANIZER_ADDRESS}`,
    "ATTENDEE;CN=Me;PARTSTAT=NEEDS-ACTION:mailto:me@example.test",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

/** One seeded tenant with its one English-speaking user and its mail world. */
export interface MailTenant {
  world: World;
  userId: string;
}

/** The mail side of an invitation test: messages that arrive, the ingest action that reads them and the user's answer. */
export interface InvitationMail {
  /** A seeded tenant with one user, so the invitations it receives are notified. */
  tenant(admin: Pool): Promise<MailTenant>;
  /**
   * A message arrives through the sync writer with one calendar part per text, in that order; `from` is its sender,
   * `null` for a message that names none. Returns its Emails item id.
   */
  receive(world: World, messageId: string, text: string | string[], from?: string | null): Promise<string>;
  /** Fires the ingest heartbeat action for `emailItemId` the way the heartbeat of the Emails database does. */
  ingest(world: World, emailItemId: string): Promise<void>;
  /** `receive` followed by `ingest`; returns the Emails item id. */
  deliver(world: World, messageId: string, text: string | string[], from?: string | null): Promise<string>;
  /** `POST /api/calendar/invitations/:id/respond` as the session user of the tenant. */
  respond(tenant: MailTenant, invitationId: string, response: string): Promise<unknown>;
}

/** The mail side of an invitation test, over `runtime`, a pool of the runtime role, and a storage of its own. */
export function createInvitationMail(runtime: Pool): InvitationMail {
  const storage = memoryStorage();
  const mail: InvitationMail = {
    async tenant(admin) {
      const tenantId = await createTestTenant(admin);
      const user = await createUser(admin, {
        tenantId,
        email: `${randomUUID()}@example.test`,
        passwordHash: "unused",
        locale: "en",
      });
      await runInTenant(tenantId, () => seedSystem(runtime));
      return { world: await setupMailAttachmentWorld(runtime, tenantId), userId: user.id };
    },
    async receive(world, messageId, text, from = ORGANIZER_ADDRESS) {
      const result = await runInTenant(world.tenantId, () =>
        withTransaction(runtime, (client) =>
          ingestEmailMessage(client, {
            emailsDatabaseId: world.databases.emails!,
            filesDatabaseId: world.databases.files!,
            folderRelationPropertyId: world.properties.emailFolder,
            attachmentsRelationPropertyId: world.properties.emailAttachments,
            mailboxItemId: world.inbox.mailboxId,
            folderItemId: world.inbox.folderId,
            messageId,
            subject: `Subject of ${messageId}`,
            bodyText: `body of ${messageId}`,
            envelope: {
              ...(from === null ? {} : { from: { name: "Sender", address: from } }),
              to: [{ address: "me@example.test" }],
            },
            attachments: (typeof text === "string" ? [text] : text).map((part, index) => ({
              filename: `invite-${index}.ics`,
              contentType: "text/calendar",
              contentId: null,
              disposition: "inline" as const,
              openStream: () => Readable.from([Buffer.from(part)]),
            })),
            storage,
            storageKeyPrefix: "invitation-mail",
          }),
        ),
      );
      return result.itemId;
    },
    ingest(world, emailItemId) {
      return runInTenant(world.tenantId, () =>
        createInvitationIngestAction(runtime, { storage })(
          { emailsDatabaseId: world.databases.emails, invitationsDatabaseId: world.databases.invitations },
          { heartbeatId: "test", projectItemId: "test", itemId: emailItemId },
        ),
      );
    },
    async deliver(world, messageId, text, from) {
      const emailItemId = await mail.receive(world, messageId, text, from);
      await mail.ingest(world, emailItemId);
      return emailItemId;
    },
    respond(tenant, invitationId, response) {
      return runInTenant(tenant.world.tenantId, () =>
        createRespondToInvitationRouteHandler(runtime)({
          params: { id: invitationId },
          body: { response },
          identity: { user: { id: tenant.userId } },
        }),
      );
    },
  };
  return mail;
}
