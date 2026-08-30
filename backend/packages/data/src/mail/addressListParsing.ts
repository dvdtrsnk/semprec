/**
 * Free-form "one address per line, or comma-separated" text — the shape both `People.emails`
 * (issue #26) and `Mailboxes.addresses` (issue #26, first consumed by issue #93's
 * deliveredToAddress alias matching) use. Shared here instead of duplicated per call site
 * (see personLinkingActions.ts / mail/deliveredTo.ts).
 */
export function parseAddressListProperty(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
