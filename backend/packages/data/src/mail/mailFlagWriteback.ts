import type { GmailMailClient } from "./gmailReconcile.js";
import type { GraphMailClient } from "./graphReconcile.js";
import type { ImapMailClient } from "./imapReconcile.js";
import {
  imapFlagForProperty,
  type PendingImapFlagWrite,
  type PendingProviderFlagWrite,
} from "./mailMessageFlagSyncStore.js";

/** Provider-specific write surface shared by the durable flag-state consumer. */
export interface MailFlagWritebackAdapter {
  write(input: PendingImapFlagWrite | PendingProviderFlagWrite): Promise<"applied" | "pending">;
}

/** IMAP's STORE FLAGS.SILENT operation is exposed by the transport as setMessageFlag. */
export function createImapMailFlagWritebackAdapter(imap: ImapMailClient): MailFlagWritebackAdapter {
  return {
    async write(input) {
      if (!("folderPath" in input)) throw new Error("IMAP write-back requires a folder UID");
      await imap.setMessageFlag(
        input.folderPath,
        input.uid,
        imapFlagForProperty(input.propertyKey),
        input.desiredState,
      );
      return "applied";
    },
  };
}

/** Gmail changes labels atomically: UNREAD mirrors `read` inversely; STARRED mirrors `flagged`. */
export function createGmailMailFlagWritebackAdapter(gmail: GmailMailClient): MailFlagWritebackAdapter {
  return {
    async write(input) {
      if (!("providerMessageId" in input)) throw new Error("Gmail write-back requires a provider message id");
      const labelId = input.propertyKey === "read" ? "UNREAD" : "STARRED";
      const present = input.propertyKey === "read" ? !input.desiredState : input.desiredState;
      await gmail.modifyMessageLabels(input.providerMessageId, present ? [labelId] : [], present ? [] : [labelId]);
      return "applied";
    },
  };
}

/** Graph represents read and flag state as independent fields on the message resource. */
export function createGraphMailFlagWritebackAdapter(graph: GraphMailClient): MailFlagWritebackAdapter {
  return {
    async write(input) {
      if (!("providerMessageId" in input)) throw new Error("Graph write-back requires a provider message id");
      await graph.patchMessage(
        input.providerMessageId,
        input.propertyKey === "read"
          ? { isRead: input.desiredState }
          : { flag: { flagStatus: input.desiredState ? "flagged" : "notFlagged" } },
      );
      return "applied";
    },
  };
}
