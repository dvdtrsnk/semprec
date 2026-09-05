/**
 * Mail addresses in the structured shape the backend's envelope stores them in
 * (`mail_message_meta.envelope`, backend/packages/data/src/mail/mailMessageMetaStore.ts) and
 * the text shape a recipient field is typed in. Compose edits text; every operation call and
 * every reply derivation works on the structured form, so the two conversions live here.
 */
export interface MailAddress {
  name?: string;
  address: string;
}

/** Same rule as the backend's `normalizeEmailAddress` — comparisons between addresses use it and nothing else. */
export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** Mirrors the backend's `formatAddress` so a draft's display text matches what a synced message shows. */
export function formatAddress(address: MailAddress): string {
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

export function formatAddressList(addresses: readonly MailAddress[]): string {
  return addresses.map(formatAddress).join(", ");
}

const ANGLE_ADDRESS = /^(.*?)<([^<>]+)>$/;

export function parseAddress(raw: string): MailAddress | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const match = trimmed.match(ANGLE_ADDRESS);
  if (!match) return { address: trimmed };
  const name = (match[1] ?? "").trim().replace(/^"(.*)"$/, "$1").trim();
  const address = (match[2] ?? "").trim();
  if (address.length === 0) return null;
  return name.length > 0 ? { name, address } : { address };
}

/**
 * Splits a typed recipient field into addresses. A separator inside a quoted display name or
 * inside angle brackets is part of the address, not between two of them — `"Doe, John"
 * <j@example.com>` is one recipient, which a plain `split(",")` would break in half.
 */
export function parseAddressList(raw: string): MailAddress[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (const char of raw) {
    if (char === '"') quoted = !quoted;
    else if (char === "<") angled = true;
    else if (char === ">") angled = false;
    else if ((char === "," || char === ";" || char === "\n") && !quoted && !angled) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);

  const addresses: MailAddress[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const address = parseAddress(part);
    if (!address) continue;
    const key = normalizeAddress(address.address);
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push(address);
  }
  return addresses;
}

/** The free-form "one address per line, or comma-separated" property shape (`Mailboxes.addresses`). */
export function parseAddressListProperty(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
