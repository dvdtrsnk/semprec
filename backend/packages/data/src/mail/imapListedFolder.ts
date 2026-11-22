import type { ImapMailClient } from "./imapMailClient.js";
import type { ImapFolderSelection } from "./imapReconcile.js";
import { logger } from "./logger.js";
import { ImapFolderUnavailableError } from "./providerTypes.js";

/**
 * The folder a pass listed, selected; `null` when the server answers that it holds no such folder any more (deleted
 * or renamed by another client since the listing), which leaves the connection usable and the folder's Folder to the
 * next pass's listing, which retires it.
 */
export async function selectListedFolder(
  imap: ImapMailClient,
  folderPath: string,
  ids: { mailboxItemId: string; folderItemId: string },
): Promise<ImapFolderSelection | null> {
  try {
    return await imap.selectFolder(folderPath);
  } catch (error) {
    if (!(error instanceof ImapFolderUnavailableError)) throw error;
    logger.info(
      { mailboxItemId: ids.mailboxItemId, folderItemId: ids.folderItemId },
      "IMAP folder gone since the listing: left to the next pass",
    );
    return null;
  }
}
