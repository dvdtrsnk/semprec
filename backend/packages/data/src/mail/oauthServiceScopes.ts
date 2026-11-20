import type { SyncMode } from "./mailAccountSyncStateStore.js";
import type { MailOauthProvider } from "./mailOauthStatesStore.js";

/** The services of an internet account a sign-in can ask consent for. */
export const MAIL_ACCOUNT_SERVICES = ["mail", "calendars"] as const;
export type MailAccountService = (typeof MAIL_ACCOUNT_SERVICES)[number];

/**
 * The least each service needs. The mail scopes are part of every sign-in: the account's identity is read through
 * them (Gmail `users.getProfile`; Graph `GET /me` needs `User.Read`, the refresh token `offline_access`), and a
 * reauthorization replaces the one stored credential, which mail sync goes on using.
 */
const SERVICE_SCOPES: Record<MailOauthProvider, Record<MailAccountService, readonly string[]>> = {
  gmail: {
    // `gmail.modify` includes read access.
    mail: ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.send"],
    calendars: ["https://www.googleapis.com/auth/calendar"],
  },
  outlook: {
    mail: ["Mail.ReadWrite", "Mail.Send", "offline_access", "User.Read"],
    calendars: ["Calendars.ReadWrite"],
  },
};

/** The scopes a sign-in for `services` asks for, in a fixed order; the mail scopes are always included. */
export function oauthScopesForServices(provider: MailOauthProvider, services: readonly MailAccountService[]): string[] {
  const scopes = SERVICE_SCOPES[provider];
  return [...scopes.mail, ...(services.includes("calendars") ? scopes.calendars : [])];
}

/** Graph reports granted scopes qualified by its resource (`https://graph.microsoft.com/Mail.Send`) in any case. */
const GRAPH_RESOURCE_PREFIX = "https://graph.microsoft.com/";

function normalizedScope(provider: MailOauthProvider, scope: string): string {
  if (provider === "gmail") return scope;
  const lower = scope.toLowerCase();
  return lower.startsWith(GRAPH_RESOURCE_PREFIX) ? lower.slice(GRAPH_RESOURCE_PREFIX.length) : lower;
}

function grantsAll(provider: MailOauthProvider, granted: readonly string[], required: readonly string[]): boolean {
  const normalized = new Set(granted.map((scope) => normalizedScope(provider, scope)));
  return required.every((scope) => normalized.has(normalizedScope(provider, scope)));
}

/** The OAuth provider whose token a sync mode uses; `imap` signs in with a password. */
function oauthProviderOfSyncMode(syncMode: SyncMode): MailOauthProvider | null {
  if (syncMode === "gmail_api") return "gmail";
  if (syncMode === "graph_api") return "outlook";
  return null;
}

/**
 * The calendar side of an internet account as clients see it: `off` while Calendars is switched off, `needsConsent`
 * for an OAuth account whose recorded grant lacks the calendar scope (an account that never recorded one included),
 * `pending` otherwise.
 */
export type CalendarStatus = "off" | "needsConsent" | "pending";

export function calendarStatusOf(account: {
  calendarsEnabled: boolean;
  syncMode: SyncMode;
  grantedScopes: readonly string[] | null;
}): CalendarStatus {
  if (!account.calendarsEnabled) return "off";
  const provider = oauthProviderOfSyncMode(account.syncMode);
  if (provider === null) return "pending";
  return grantsAll(provider, account.grantedScopes ?? [], SERVICE_SCOPES[provider].calendars)
    ? "pending"
    : "needsConsent";
}
