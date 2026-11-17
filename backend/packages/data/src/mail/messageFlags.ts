/**
 * The two user-owned Emails flags and the IMAP system flags they mirror. Ingest and the outbound flag
 * write both name the flags from here, so they can never disagree. The properties are ordinary
 * `owner: 'user'` checkboxes written through the generic item-update path.
 */
export const READ_PROPERTY_KEY = "read";
export const FLAGGED_PROPERTY_KEY = "flagged";

export const IMAP_SEEN_FLAG = "\\Seen";
export const IMAP_FLAGGED_FLAG = "\\Flagged";

/** The only IMAP flags ever written over `STORE`; a union so the write surface takes no arbitrary string. */
export type WritableImapFlag = typeof IMAP_SEEN_FLAG | typeof IMAP_FLAGGED_FLAG;

export const MESSAGE_FLAG_PROPERTIES: ReadonlyArray<{ propertyKey: string; imapFlag: WritableImapFlag }> = [
  { propertyKey: READ_PROPERTY_KEY, imapFlag: IMAP_SEEN_FLAG },
  { propertyKey: FLAGGED_PROPERTY_KEY, imapFlag: IMAP_FLAGGED_FLAG },
];

/**
 * Folders whose messages are read by definition: the user wrote the draft, and sending keeps the same
 * Emails item in Sent. The unread search and filter leave these folders out.
 */
export const DRAFTS_AND_SENT_SPECIAL_PURPOSES = ["drafts", "sent"] as const;

/**
 * Returns `{}` when the adapter reported no flags (every non-IMAP adapter); absent reads as unread and
 * unflagged. RFC 3501 system flags are case-insensitive.
 */
export function messageFlagProperties(flags: readonly string[] | undefined): Record<string, boolean> {
  if (!flags) return {};
  const present = new Set(flags.map((flag) => flag.toLowerCase()));
  const properties: Record<string, boolean> = {};
  for (const { propertyKey, imapFlag } of MESSAGE_FLAG_PROPERTIES) {
    properties[propertyKey] = present.has(imapFlag.toLowerCase());
  }
  return properties;
}
