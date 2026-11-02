/** The raw header values the bulk-mail detector looks at; `null`/`undefined` means the header was absent. */
export interface BulkMailHeaders {
  listUnsubscribe?: string | null;
  listId?: string | null;
  precedence?: string | null;
  autoSubmitted?: string | null;
}

export interface DetectBulkMailInput extends BulkMailHeaders {
  senderAddress?: string | null;
}

const BULK_PRECEDENCE_VALUES = new Set(["bulk", "list", "junk"]);
const AUTOMATIC_SENDER_LOCAL_PART = /^(no-?reply|do-?not-?reply|mailer-daemon|notifications?)$/i;

/**
 * True when a message looks like bulk or automatic mail (newsletter, notification, auto-reply) rather
 * than mail from a person. Header values arrive from the outside world, so every input is treated as
 * untrusted: a missing or non-string value counts as absent, and nothing here throws.
 */
export function detectBulkMail(input: DetectBulkMailInput): boolean {
  if (typeof input.listUnsubscribe === "string" || typeof input.listId === "string") return true;

  if (typeof input.precedence === "string" && BULK_PRECEDENCE_VALUES.has(input.precedence.trim().toLowerCase())) {
    return true;
  }

  if (typeof input.autoSubmitted === "string" && input.autoSubmitted.trim().toLowerCase() !== "no") return true;

  if (typeof input.senderAddress === "string") {
    const at = input.senderAddress.lastIndexOf("@");
    const localPart = (at === -1 ? input.senderAddress : input.senderAddress.slice(0, at)).trim();
    if (AUTOMATIC_SENDER_LOCAL_PART.test(localPart)) return true;
  }
  return false;
}
