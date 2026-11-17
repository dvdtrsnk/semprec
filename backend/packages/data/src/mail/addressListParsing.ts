/** Parses "one address per line, or comma-separated" text (`People.emails`, `Mailboxes.addresses`). */
export function parseAddressListProperty(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
