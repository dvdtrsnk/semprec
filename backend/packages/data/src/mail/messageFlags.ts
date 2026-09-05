/**
 * The mapping between the two user-owned Emails flags the mailbox triage actions write
 * (issue #97) and the canonical IMAP system flags they mirror. Both the ingest direction
 * (IMAP flags -> item properties, below) and the outbound direction (a flag write over
 * IMAP, `ImapFlowMailClient.setMessageFlag`) name the flags from here, so the two can never
 * disagree about which property is which flag.
 *
 * The properties themselves are ordinary generic checkboxes on Emails, owner:'user' — the
 * mailbox marks a message read or flagged through the generic item-update path, exactly like
 * any other user-owned property, not through a mailbox-only endpoint.
 */
export const READ_PROPERTY_KEY = "read";
export const FLAGGED_PROPERTY_KEY = "flagged";

export const IMAP_SEEN_FLAG = "\\Seen";
export const IMAP_FLAGGED_FLAG = "\\Flagged";

export const MESSAGE_FLAG_PROPERTIES: ReadonlyArray<{ propertyKey: string; imapFlag: string }> = [
  { propertyKey: READ_PROPERTY_KEY, imapFlag: IMAP_SEEN_FLAG },
  { propertyKey: FLAGGED_PROPERTY_KEY, imapFlag: IMAP_FLAGGED_FLAG },
];

/**
 * The `read`/`flagged` properties a newly ingested message starts out with, derived from the
 * IMAP flags the fetch reported. Returns `{}` when the adapter reported no flags at all
 * (every non-IMAP adapter), leaving both properties absent — which the mailbox reads as
 * unread and unflagged, the same as an explicit `false`.
 *
 * RFC 3501 system flags are case-insensitive, so `\seen` counts the same as `\Seen`.
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
