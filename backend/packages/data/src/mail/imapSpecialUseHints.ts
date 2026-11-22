import type { ListOptions } from "imapflow";

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
