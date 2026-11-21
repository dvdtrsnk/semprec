import type { GmailMailClient } from "./gmailReconcile.js";
import type { GraphMailClient } from "./graphReconcile.js";
import type { ImapMailClient } from "./imapReconcile.js";
import type { Pool } from "pg";
import {
  imapFlagForProperty,
  listPendingProviderFlagWrites,
  type PendingImapFlagWrite,
  type PendingProviderFlagWrite,
} from "./mailMessageFlagSyncStore.js";
import { hasUnsettledMailMove, protectedMailMovesForPass, type MailMoveBaseline } from "./mailMessageMoveSyncStore.js";
import { inPassTransaction, type MailSyncPass } from "./mailSyncPass.js";

export interface MailFlagWritebackAdapter {
  write(input: PendingImapFlagWrite | PendingProviderFlagWrite): Promise<"applied" | "pending">;
}

/** STORE FLAGS.SILENT, exposed by the transport as setMessageFlag. */
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

/**
 * The flag write-back of a Gmail or Graph pass: the pending writes are read in one pass transaction, then written to
 * the provider with no transaction open. Returns the writes the provider applied, for the caller to confirm in its
 * final transaction (a desired state changed since stays pending), or `null` when the pass ended. Rows only exist where
 * observed != desired, so provider changes are not echoed back.
 */
export async function writeBackProviderFlags(
  pool: Pool,
  pass: MailSyncPass,
  input: {
    mailboxItemId: string;
    moveBaseline?: MailMoveBaseline;
    protectedMoveMessageIds?: ReadonlySet<string>;
    folderRelationDefinitionId: string;
    mailboxFolderRelationDefinitionId: string;
  },
  adapter: MailFlagWritebackAdapter,
): Promise<PendingProviderFlagWrite[] | null> {
  const pending = await inPassTransaction(pool, pass, async (client) => {
    const protectedMoveMessageIds = await protectedMailMovesForPass(
      client,
      input.mailboxItemId,
      input.moveBaseline,
      input.protectedMoveMessageIds,
    );
    const writes: PendingProviderFlagWrite[] = [];
    for (const write of await listPendingProviderFlagWrites(client, input)) {
      if (protectedMoveMessageIds.has(write.messageItemId) || (await hasUnsettledMailMove(client, write.messageItemId)))
        continue;
      writes.push(write);
    }
    return writes;
  });
  if (!pending) return null;
  const applied: PendingProviderFlagWrite[] = [];
  for (const write of pending.value) {
    if ((await adapter.write(write)) === "applied") applied.push(write);
  }
  return applied;
}
