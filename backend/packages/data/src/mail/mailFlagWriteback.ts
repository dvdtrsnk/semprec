import type { ImapMailClient } from "./imapReconcile.js";
import { imapFlagForProperty, type PendingImapFlagWrite } from "./mailMessageFlagSyncStore.js";

/** Provider-specific write surface shared by the durable flag-state consumer. */
export interface MailFlagWritebackAdapter {
  write(input: PendingImapFlagWrite): Promise<"applied" | "pending">;
}

/** IMAP's STORE FLAGS.SILENT operation is exposed by the transport as setMessageFlag. */
export function createImapMailFlagWritebackAdapter(imap: ImapMailClient): MailFlagWritebackAdapter {
  return {
    async write(input) {
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

/** #199 supplies the Gmail `users.messages.modify` mutation; until then desired state remains durably pending. */
export function createGmailMailFlagWritebackAdapter(): MailFlagWritebackAdapter {
  return {
    async write() {
      return "pending";
    },
  };
}

/** #199 supplies the Graph `PATCH` mutation; until then desired state remains durably pending. */
export function createGraphMailFlagWritebackAdapter(): MailFlagWritebackAdapter {
  return {
    async write() {
      return "pending";
    },
  };
}
