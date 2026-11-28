import { isIP } from "node:net";
import type { Queryable } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { ValidationError } from "../errors.js";
import { isBaselineOutboundUrl } from "../net/storedOutboundUrl.js";

export const MAIL_SERVER_PORTS = [993, 143, 465, 587] as const;
export const MAIL_SERVER_SECURITIES = ["tls", "starttls"] as const;
export type MailServerSecurity = (typeof MAIL_SERVER_SECURITIES)[number];

/** Host, port and security are always set together. */
export interface MailServerEndpoint {
  host: string;
  port: number;
  security: MailServerSecurity;
}

/** The password lives in `external_credentials`. */
export interface MailServerSettingsInput {
  imap: MailServerEndpoint | null;
  smtp: MailServerEndpoint | null;
  username: string;
  /** A generic account's CalDAV address (`normalizeCalDavUrl`); absent or `null` when discovery uses its domain. */
  caldavUrl?: string | null;
}

export interface MailServerSettings extends MailServerSettingsInput {
  mailboxItemId: string;
  caldavUrl: string | null;
}

type SettingsDbRow = {
  mailbox_item_id: string;
  imap_host: string | null;
  imap_port: number | null;
  imap_security: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_security: string | null;
  username: string;
  caldav_url: string | null;
};

const COLUMNS =
  "mailbox_item_id, imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security, username, caldav_url";
const MAX_HOST_LENGTH = 253;
const MAX_USERNAME_LENGTH = 320;
const MAX_CALDAV_URL_LENGTH = 2048;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_SUFFIXES = [".localhost", ".local", ".internal"];

/**
 * Returns the host lower-cased. It must be a DNS name: no IP literal in any notation, no `localhost`, nothing ending
 * in `.localhost`, `.local` or `.internal`. Input contract only; resolved addresses are checked at connect time.
 */
export function normalizeMailServerHost(raw: unknown, field: string): string {
  if (typeof raw !== "string") throw new ValidationError(`${field} must be a string`, { field });
  const host = raw.trim().toLowerCase();
  if (host.length === 0 || host.length > MAX_HOST_LENGTH) {
    throw new ValidationError(`${field} must be 1 to ${MAX_HOST_LENGTH} characters`, { field });
  }
  const bare = host.endsWith(".") ? host.slice(0, -1) : host;
  const labels = bare.split(".");
  const lastLabel = labels[labels.length - 1] ?? "";
  // A bracketed or colon IPv6 form, or an IPv4 in dotted, decimal, hex or octal notation, is not a name.
  if (bare.includes(":") || bare.includes("[") || isIP(bare) !== 0 || /^(0x[0-9a-f]*|\d+)$/.test(lastLabel)) {
    throw new ValidationError(`${field} must be a DNS name, not an IP address`, { field });
  }
  if (bare === "localhost" || RESERVED_SUFFIXES.some((suffix) => bare.endsWith(suffix))) {
    throw new ValidationError(`${field} must not be a local name`, { field });
  }
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) {
    throw new ValidationError(`${field} must be a valid DNS name`, { field });
  }
  return bare;
}

/**
 * Returns the URL as `URL` writes it. It must pass the stored outbound URL baseline (`https:`, default port, no
 * userinfo, a DNS name that is no IP literal and not `localhost`) and its host the same name rules as a mail server.
 * Input contract only; resolved addresses are checked at connect time.
 */
export function normalizeCalDavUrl(raw: unknown, field = "caldavUrl"): string {
  if (typeof raw !== "string" || raw.trim().length === 0 || raw.length > MAX_CALDAV_URL_LENGTH) {
    throw new ValidationError(`${field} must be 1 to ${MAX_CALDAV_URL_LENGTH} characters`, { field });
  }
  const value = raw.trim();
  if (!isBaselineOutboundUrl(value)) {
    throw new ValidationError(`${field} must be an https URL of a DNS name on the default port`, { field });
  }
  const url = new URL(value);
  normalizeMailServerHost(url.hostname, field);
  url.hash = "";
  if (url.href.length > MAX_CALDAV_URL_LENGTH) {
    throw new ValidationError(`${field} must be 1 to ${MAX_CALDAV_URL_LENGTH} characters`, { field });
  }
  return url.href;
}

/** Whether `normalizeCalDavUrl` accepts the value. */
export function isStorableCalDavUrl(raw: string): boolean {
  try {
    normalizeCalDavUrl(raw);
    return true;
  } catch (error) {
    if (error instanceof ValidationError) return false;
    throw error;
  }
}

function validatePort(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !(MAIL_SERVER_PORTS as readonly number[]).includes(raw)) {
    throw new ValidationError(`${field} must be one of ${MAIL_SERVER_PORTS.join(", ")}`, { field });
  }
  return raw;
}

function validateSecurity(raw: unknown, field: string): MailServerSecurity {
  if (typeof raw !== "string" || !(MAIL_SERVER_SECURITIES as readonly string[]).includes(raw)) {
    throw new ValidationError(`${field} must be one of ${MAIL_SERVER_SECURITIES.join(", ")}`, { field });
  }
  return raw as MailServerSecurity;
}

function validateEndpoint(endpoint: MailServerEndpoint | null, prefix: "imap" | "smtp"): MailServerEndpoint | null {
  if (endpoint === null) return null;
  return {
    host: normalizeMailServerHost(endpoint.host, `${prefix}Host`),
    port: validatePort(endpoint.port, `${prefix}Port`),
    security: validateSecurity(endpoint.security, `${prefix}Security`),
  };
}

function validateUsername(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0 || raw.length > MAX_USERNAME_LENGTH) {
    throw new ValidationError(`username must be 1 to ${MAX_USERNAME_LENGTH} characters`, { field: "username" });
  }
  return raw;
}

function endpointOf(
  host: string | null,
  port: number | null,
  security: string | null,
  column: string,
): MailServerEndpoint | null {
  if (host === null || port === null || security === null) return null;
  return { host, port, security: assertKnownValue(MAIL_SERVER_SECURITIES, security, column) };
}

function toSettings(row: SettingsDbRow): MailServerSettings {
  return {
    mailboxItemId: row.mailbox_item_id,
    imap: endpointOf(row.imap_host, row.imap_port, row.imap_security, "mail_account_server_settings.imap_security"),
    smtp: endpointOf(row.smtp_host, row.smtp_port, row.smtp_security, "mail_account_server_settings.smtp_security"),
    username: row.username,
    caldavUrl: row.caldav_url,
  };
}

export async function getMailServerSettings(db: Queryable, mailboxItemId: string): Promise<MailServerSettings | null> {
  const { rows } = await db.query<SettingsDbRow>(
    `SELECT ${COLUMNS} FROM mail_account_server_settings WHERE mailbox_item_id = $1`,
    [mailboxItemId],
  );
  const row = rows[0];
  return row ? toSettings(row) : null;
}

export async function upsertMailServerSettings(
  db: Queryable,
  mailboxItemId: string,
  input: MailServerSettingsInput,
): Promise<MailServerSettings> {
  const imap = validateEndpoint(input.imap, "imap");
  const smtp = validateEndpoint(input.smtp, "smtp");
  const username = validateUsername(input.username);
  const caldavUrl =
    input.caldavUrl === undefined || input.caldavUrl === null ? null : normalizeCalDavUrl(input.caldavUrl);
  const { rows } = await db.query<SettingsDbRow>(
    `INSERT INTO mail_account_server_settings
       (mailbox_item_id, imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security, username,
        caldav_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (mailbox_item_id) DO UPDATE SET
       imap_host = EXCLUDED.imap_host, imap_port = EXCLUDED.imap_port, imap_security = EXCLUDED.imap_security,
       smtp_host = EXCLUDED.smtp_host, smtp_port = EXCLUDED.smtp_port, smtp_security = EXCLUDED.smtp_security,
       username = EXCLUDED.username, caldav_url = EXCLUDED.caldav_url, updated_at = now()
     RETURNING ${COLUMNS}`,
    [
      mailboxItemId,
      imap?.host ?? null,
      imap?.port ?? null,
      imap?.security ?? null,
      smtp?.host ?? null,
      smtp?.port ?? null,
      smtp?.security ?? null,
      username,
      caldavUrl,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error(`Upserting mail server settings for ${mailboxItemId} returned no row`);
  return toSettings(row);
}

/**
 * Stores the CalDAV server discovery resolved for an account that has none (its domain's well-known address delegated
 * it elsewhere), so every later discovery starts there. The Mailboxes item is read `FOR SHARE` first, so a password
 * replacement, which rewrites the row under the item's `FOR UPDATE` lock, reads the stored address or runs first.
 * Returns whether it was stored: `false` for an account that is gone, trashed, has no settings row or has a CalDAV
 * address already.
 */
export async function recordResolvedCalDavUrl(db: Queryable, mailboxItemId: string, raw: string): Promise<boolean> {
  const caldavUrl = normalizeCalDavUrl(raw);
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM items WHERE id = $1 AND deleted_at IS NULL FOR SHARE",
    [mailboxItemId],
  );
  if (rows[0] === undefined) return false;
  const result = await db.query(
    `UPDATE mail_account_server_settings SET caldav_url = $2, updated_at = now()
      WHERE mailbox_item_id = $1 AND caldav_url IS NULL`,
    [mailboxItemId, caldavUrl],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Returns whether a row existed. */
export async function deleteMailServerSettings(db: Queryable, mailboxItemId: string): Promise<boolean> {
  const result = await db.query("DELETE FROM mail_account_server_settings WHERE mailbox_item_id = $1", [mailboxItemId]);
  return (result.rowCount ?? 0) > 0;
}
