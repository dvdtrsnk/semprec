import type { ListOptions } from "imapflow";
import type { ProviderFolder } from "./folderDiscovery.js";

/** The IMAP host of every iCloud Mail account. */
export const ICLOUD_IMAP_HOST = "imap.mail.me.com";

/**
 * iCloud flags only its Sent and Trash folders and has no SPECIAL-USE capability, so imapflow guesses the other
 * purposes from folder names and, of several candidates, takes the first in path order: a user's "Archiv" over
 * iCloud's own "Archive", an emoji-named "…/Spam" over "Junk". iCloud gives these folders the same names in every
 * account, whatever its language.
 */
const ICLOUD_SPECIAL_USE_HINTS: NonNullable<ListOptions["specialUseHints"]> = {
  sent: "Sent Messages",
  trash: "Deleted Messages",
  drafts: "Drafts",
  junk: "Junk",
  archive: "Archive",
};

/** The folders whose purpose a server's own folder names fix, for a LIST; a hinted folder the server lacks is ignored. */
export function imapListOptions(host: string): ListOptions {
  return host === ICLOUD_IMAP_HOST ? { specialUseHints: ICLOUD_SPECIAL_USE_HINTS } : {};
}

const SPECIAL_USE_TO_PURPOSE: Record<string, string> = {
  "\\Inbox": "inbox",
  "\\Sent": "sent",
  "\\Junk": "junk",
  "\\Trash": "trash",
  "\\Drafts": "drafts",
  "\\Archive": "archive",
  "\\All": "all",
};

/** A listed IMAP folder as its Folder item: named by its path, its purpose from its RFC 6154 special-use attribute. */
export function imapProviderFolder(folder: { path: string; specialUse?: string }): ProviderFolder {
  return {
    providerId: folder.path,
    name: folder.path,
    behavior: "folder",
    specialPurpose: (folder.specialUse && SPECIAL_USE_TO_PURPOSE[folder.specialUse]) ?? "none",
  };
}
