import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { areCalendarsEnabled, NEW_MAILBOX_SERVICE_SWITCHES } from "./mailboxServiceHooks.js";
import { getItemById, lockItemById } from "../chokePoint/itemsStore.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { withTransaction } from "../db/pool.js";
import { ChokePointError, NotFoundError, RateLimitedError, ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";
import {
  clearMailSyncFailure,
  ensureMailAccountSyncState,
  getMailAccountSyncState,
  lockMailAccountSyncState,
  ProviderAccountAlreadyConnectedError,
  recordProviderAccountAddress,
  type MailAccountSyncStateRow,
} from "./mailAccountSyncStateStore.js";
import { mailboxHoldsAnyAddress, writeMailboxAddresses } from "./mailboxAddresses.js";
import type { VerifiedMailServerSettings, VerifyMailCredentialsInput } from "./mailCredentialVerification.js";
import { resolveMailModuleIds } from "./mailModuleIds.js";
import {
  getMailServerSettings,
  normalizeCalDavUrl,
  normalizeMailServerHost,
  upsertMailServerSettings,
  type MailServerSettings,
} from "./mailServerSettingsStore.js";
import { enqueueMailAccountSync } from "./mailSyncEnqueue.js";
import {
  MailAppPasswordRequiredError,
  MailAuthFailedError,
  MailServerUnreachableError,
  MailTlsFailedError,
} from "./providerTypes.js";
import type { RouteBody, RouteParams, RouteUser } from "../customRoute.js";
import {
  ICLOUD_CALDAV_URL,
  isCalDavVerificationRefusal,
  type VerifyCalDavServerInput,
} from "../calendar/sync/adapters/caldav/caldavConnectVerification.js";
import { enqueueCalendarAccountSync } from "../calendar/sync/calendarAccountSyncEnqueue.js";
import { clearCalendarSyncReauthorization } from "../calendar/sync/calendarSyncStore.js";
import { parseAddressListProperty } from "./addressListParsing.js";

/** Gmail and Outlook sign in through OAuth instead. */
const PASSWORD_MAILBOX_PROVIDERS = ["icloud", "generic"] as const;
type PasswordMailboxProvider = (typeof PASSWORD_MAILBOX_PROVIDERS)[number];

/** The address is the default user name, so it shares the stored user name bound. */
const MAX_ADDRESS_LENGTH = 320;
const MAX_USERNAME_LENGTH = 320;
/** Far above any password a mail provider issues; bounds what is sealed and sent to the mail server. */
const MAX_PASSWORD_LENGTH = 1024;

/** `Mailboxes.addresses` separates entries by line breaks and commas, so neither may appear in one. */
const ADDRESS_PATTERN = /^[^\s@,]+@[^\s@,]+$/;

const UNSTORABLE_CHARACTER = /[\p{Cc}\p{Cs}]/u;

/**
 * `text`/`jsonb` refuse U+0000, `jsonb` refuses an unpaired surrogate, and one bound as `text` arrives as
 * U+FFFD, so such a value would fail or be stored changed after passing body validation.
 */
function isStorableText(value: string): boolean {
  return !UNSTORABLE_CHARACTER.test(value);
}

const connectBodySchema = z
  .object({
    provider: z.enum(PASSWORD_MAILBOX_PROVIDERS),
    address: z.string().trim().max(MAX_ADDRESS_LENGTH).regex(ADDRESS_PATTERN).refine(isStorableText),
    // Any character is accepted: `storeCredential` binds the sealed bytes, never this text.
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
    // Validated by `normalizeMailServerHost`.
    imapHost: z.string().optional(),
    smtpHost: z.string().optional(),
    // Validated by `normalizeCalDavUrl`.
    caldavUrl: z.string().optional(),
    username: z
      .string()
      .max(MAX_USERNAME_LENGTH)
      .refine((value) => value.trim().length > 0)
      .refine(isStorableText)
      .optional(),
  })
  .strict();

interface ConnectRequest {
  provider: PasswordMailboxProvider;
  address: string;
  username: string;
  password: string;
  /** `null` for iCloud, whose hosts `verifyMailCredentials` fixes. */
  hosts: { imapHost: string; smtpHost: string } | null;
  /** A generic account's CalDAV address; `null` when its calendars are found from its domain or it is iCloud. */
  caldavUrl: string | null;
}

/** No refusal message repeats a value of the body. */
function parseConnectRequest(body: unknown): ConnectRequest {
  const parsed = connectBodySchema.safeParse(body);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    throw new ValidationError(
      "The body must hold 'provider', 'address' and 'password', and may hold 'username', 'imapHost', 'smtpHost' and 'caldavUrl'",
      typeof field === "string" ? { field } : undefined,
    );
  }
  const { provider, address, password, imapHost, smtpHost, caldavUrl } = parsed.data;
  const username = parsed.data.username ?? address;
  if (provider === "icloud") {
    if (imapHost !== undefined) {
      throw new ValidationError("imapHost is not accepted for an iCloud mailbox", { field: "imapHost" });
    }
    if (smtpHost !== undefined) {
      throw new ValidationError("smtpHost is not accepted for an iCloud mailbox", { field: "smtpHost" });
    }
    if (caldavUrl !== undefined) {
      throw new ValidationError("caldavUrl is not accepted for an iCloud mailbox", { field: "caldavUrl" });
    }
    return { provider, address, username, password, hosts: null, caldavUrl: null };
  }
  return {
    provider,
    address,
    username,
    password,
    hosts: {
      imapHost: normalizeMailServerHost(imapHost, "imapHost"),
      smtpHost: normalizeMailServerHost(smtpHost, "smtpHost"),
    },
    caldavUrl: caldavUrl === undefined ? null : normalizeCalDavUrl(caldavUrl),
  };
}

/**
 * The stored name a new mailbox starts with, which the person may rename. It is a name, not a label, so it is in no
 * language: "iCloud", like "Gmail" and "Outlook", and the domain of the address for any other server.
 */
function defaultMailboxName(provider: PasswordMailboxProvider, address: string): string {
  return provider === "icloud" ? "iCloud" : address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

function mailboxHoldsAddress(client: PoolClient, mailboxesDatabaseId: string, address: string): Promise<boolean> {
  return mailboxHoldsAnyAddress(client, { mailboxesDatabaseId, addresses: [address] });
}

type VerificationRefusal =
  MailAuthFailedError | MailAppPasswordRequiredError | MailServerUnreachableError | MailTlsFailedError;

function isVerificationRefusal(error: unknown): error is VerificationRefusal {
  return (
    error instanceof MailAuthFailedError ||
    error instanceof MailAppPasswordRequiredError ||
    error instanceof MailServerUnreachableError ||
    error instanceof MailTlsFailedError
  );
}

interface NewPasswordMailbox {
  request: ConnectRequest;
  name: string;
  verified: VerifiedMailServerSettings;
  userId: string;
}

/**
 * The duplicate rule is read again first. `recordProviderAccountAddress` refuses an address a concurrent
 * request recorded meanwhile; Postgres has aborted the transaction by then, so the caller rolls back.
 */
async function createPasswordMailbox(client: PoolClient, mailbox: NewPasswordMailbox): Promise<ItemRow> {
  const { request } = mailbox;
  const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
  if (await mailboxHoldsAddress(client, mailboxesDatabaseId, request.address)) {
    throw new ProviderAccountAlreadyConnectedError();
  }
  const created = await createItemWithClient(
    client,
    {
      databaseId: mailboxesDatabaseId,
      properties: { name: mailbox.name, provider: request.provider, ...NEW_MAILBOX_SERVICE_SWITCHES },
    },
    { actingUserId: mailbox.userId, writer: { writerKind: "user" } },
  );
  await writeMailboxAddresses(client, { mailboxesDatabaseId, mailboxItemId: created.id, address: request.address });
  await storeCredential(client, {
    itemId: created.id,
    credentialType: request.provider === "icloud" ? "app_password" : "plain_password",
    plaintext: request.password,
  });
  await upsertMailServerSettings(client, created.id, {
    imap: mailbox.verified.imap,
    smtp: mailbox.verified.smtp,
    username: request.username,
    caldavUrl: request.caldavUrl,
  });
  await ensureMailAccountSyncState(client, { itemId: created.id, syncMode: "imap" });
  await recordProviderAccountAddress(client, created.id, request.address);
  await enqueueMailAccountSync(client, created.id);
  const item = await getItemById(client, mailboxesDatabaseId, created.id);
  if (!item) throw new Error(`Mailbox ${created.id} is missing in the transaction that created it`);
  return item;
}

type VerifyPassword = (input: VerifyMailCredentialsInput) => Promise<VerifiedMailServerSettings>;
type VerifyCalDav = (input: VerifyCalDavServerInput) => Promise<void>;

type VerificationAttempt = { granted: true } | { granted: false; retryAfterSeconds: number };

interface VerificationThrottle {
  /** Checks and counts in the same synchronous step. */
  tryAcquire(action: "mailboxCredentialVerification", userId: string): VerificationAttempt;
}

export interface MailboxPasswordRouteDependencies {
  mailServerClients?: {
    verifyPassword?: VerifyPassword;
    verifyCalDav?: VerifyCalDav;
  };
  throttle?: VerificationThrottle;
  /** Called by the password replacement after its commit. */
  mailLiveSync?: { restartAccount(mailboxItemId: string): Promise<void> };
}

/** A missing member is deployment misconfiguration: plain error (generic 500), not a `ChokePointError`. */
function requireVerifyPassword(dependencies: MailboxPasswordRouteDependencies): VerifyPassword {
  const verifyPassword = dependencies.mailServerClients?.verifyPassword;
  if (!verifyPassword) {
    throw new Error(
      'custom route dependency "mailServerClients.verifyPassword" is not configured by the composition root',
    );
  }
  return verifyPassword;
}

/** Fails like `requireVerifyPassword`; only a request with a CalDAV address needs it. */
function requireVerifyCalDav(dependencies: MailboxPasswordRouteDependencies): VerifyCalDav {
  const verifyCalDav = dependencies.mailServerClients?.verifyCalDav;
  if (!verifyCalDav) {
    throw new Error(
      'custom route dependency "mailServerClients.verifyCalDav" is not configured by the composition root',
    );
  }
  return verifyCalDav;
}

/** Fails like `requireVerifyPassword`, so the route never verifies a login it cannot count. */
function requireThrottle(dependencies: MailboxPasswordRouteDependencies): VerificationThrottle {
  const throttle = dependencies.throttle;
  if (!throttle) {
    throw new Error('custom route dependency "throttle" is not configured by the composition root');
  }
  return throttle;
}

/**
 * `POST /api/mail/mailboxes` connects an iCloud or a generic IMAP mailbox. No transaction is open across
 * the verification:
 *
 * 1. One transaction reads the duplicate rule (409 `provider_account_already_connected`).
 * 2. The attempt is counted per user (429 `rate_limited`); earlier refusals are not counted, and a counted
 *    attempt stays counted.
 * 3. Outside any transaction the login is verified on both protocols, and on CalDAV when the body names a CalDAV
 *    address; a refusal answers 400 with its code.
 * 4. One transaction rereads the duplicate rule and writes the mailbox; a race answers 409 and rolls back
 *    everything.
 *
 * The password is sealed by `storeCredential` and is in no response and no log line.
 */
export function createMailboxPasswordConnectRouteHandler(pool: Pool, dependencies: MailboxPasswordRouteDependencies) {
  return async (ctx: RouteBody & RouteUser): Promise<{ status: number; item: ItemRow }> => {
    const request = parseConnectRequest(ctx.body);
    // Read per request: a mount without a member must still start.
    const verifyPassword = requireVerifyPassword(dependencies);
    const verifyCalDav = request.caldavUrl === null ? null : requireVerifyCalDav(dependencies);
    const throttle = requireThrottle(dependencies);
    const name = defaultMailboxName(request.provider, request.address);

    await withTransaction(pool, async (client) => {
      const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
      if (await mailboxHoldsAddress(client, mailboxesDatabaseId, request.address)) {
        throw new ProviderAccountAlreadyConnectedError();
      }
    });

    // No `await` between the count and the call, so exactly the counted requests verify.
    const attempt = throttle.tryAcquire("mailboxCredentialVerification", ctx.identity.user.id);
    if (!attempt.granted) throw new RateLimitedError(attempt.retryAfterSeconds);

    let verified: VerifiedMailServerSettings;
    try {
      verified = await verifyPassword({
        provider: request.provider,
        address: request.address,
        username: request.username,
        password: request.password,
        ...(request.hosts ?? {}),
      });
    } catch (error) {
      if (isVerificationRefusal(error)) throw new ChokePointError(400, error.code, error.message);
      throw error;
    }
    if (verifyCalDav !== null && request.caldavUrl !== null) {
      try {
        await verifyCalDav({ caldavUrl: request.caldavUrl, username: request.username, password: request.password });
      } catch (error) {
        if (isCalDavVerificationRefusal(error)) throw new ChokePointError(400, error.code, error.message);
        throw error;
      }
    }

    const item = await withTransaction(pool, (client) =>
      createPasswordMailbox(client, { request, name, verified, userId: ctx.identity.user.id }),
    );
    return { status: 201, item };
  };
}

const passwordBodySchema = z
  .object({
    // Any character is accepted: `storeCredential` binds the sealed bytes, never this text.
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
    username: z
      .string()
      .max(MAX_USERNAME_LENGTH)
      .refine((value) => value.trim().length > 0)
      .refine(isStorableText)
      .optional(),
  })
  .strict();

/** A malformed id names no mailbox, so it gets the same 404 as an unknown one. */
const mailboxIdSchema = z.uuid();

function mailboxNotFound(): NotFoundError {
  return new NotFoundError("Mailbox not found");
}

function mailboxNotPassword(): ChokePointError {
  return new ChokePointError(409, "mailbox_not_password", "This mailbox does not sign in with a password");
}

function isPasswordMailboxProvider(value: unknown): value is PasswordMailboxProvider {
  return typeof value === "string" && (PASSWORD_MAILBOX_PROVIDERS as readonly string[]).includes(value);
}

interface PasswordAccount {
  mailbox: ItemRow;
  provider: PasswordMailboxProvider;
  /** The first entry of `Mailboxes.addresses`; empty for a mailbox that lists none. */
  address: string;
  settings: MailServerSettings & {
    imap: NonNullable<MailServerSettings["imap"]>;
    smtp: NonNullable<MailServerSettings["smtp"]>;
  };
}

/**
 * `null` mailbox (unknown, trashed, or another tenant's, which RLS hides) is a 404. The password goes to the IMAP and
 * SMTP servers of the stored settings, so the account must be an `icloud` or `generic` one with both endpoints stored
 * and, when it has a sync state, IMAP sync; anything else is 409 `mailbox_not_password`.
 */
async function passwordAccountOf(
  client: PoolClient,
  mailbox: ItemRow | null,
  syncState: MailAccountSyncStateRow | null,
): Promise<PasswordAccount> {
  if (mailbox === null || mailbox.deletedAt !== null) throw mailboxNotFound();
  const provider = mailbox.properties.provider;
  if (!isPasswordMailboxProvider(provider)) throw mailboxNotPassword();
  if (syncState !== null && syncState.syncMode !== "imap") throw mailboxNotPassword();
  const settings = await getMailServerSettings(client, mailbox.id);
  if (settings === null || settings.imap === null || settings.smtp === null) throw mailboxNotPassword();
  const address = parseAddressListProperty(mailbox.properties.addresses)[0] ?? "";
  return { mailbox, provider, address, settings: { ...settings, imap: settings.imap, smtp: settings.smtp } };
}

/** Where the account's calendar discovery starts, or `null` when its calendars are found from its domain. */
function calDavUrlOf(account: PasswordAccount): string | null {
  return account.provider === "icloud" ? ICLOUD_CALDAV_URL : account.settings.caldavUrl;
}

/** Fails like `requireVerifyPassword`, so no password is replaced that the live sync would not read. */
function requireLiveSync(
  dependencies: MailboxPasswordRouteDependencies,
): NonNullable<MailboxPasswordRouteDependencies["mailLiveSync"]> {
  const liveSync = dependencies.mailLiveSync;
  if (!liveSync) {
    throw new Error('custom route dependency "mailLiveSync" is not configured by the composition root');
  }
  return liveSync;
}

interface PasswordReplacement {
  mailboxItemId: string;
  password: string;
  /** `null` keeps the stored user name. */
  username: string | null;
  verified: VerifiedMailServerSettings;
}

/**
 * The sync state row is locked before the Mailboxes item, the order the sync job and the OAuth reauthorization take
 * them; an account without a sync state row gets one first. The account is checked again on the locked rows.
 */
async function replaceMailboxPassword(client: PoolClient, replacement: PasswordReplacement): Promise<ItemRow> {
  const { mailboxItemId } = replacement;
  const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
  // Unlocked and no guard: it keeps the next statement from running for a foreign id, whose sync state insert would
  // collide with a row RLS hides and fail unexpectedly.
  await passwordAccountOf(
    client,
    await getItemById(client, mailboxesDatabaseId, mailboxItemId),
    await getMailAccountSyncState(client, mailboxItemId),
  );
  await ensureMailAccountSyncState(client, { itemId: mailboxItemId, syncMode: "imap" });
  const syncState = await lockMailAccountSyncState(client, mailboxItemId);
  const account = await passwordAccountOf(
    client,
    await lockItemById(client, mailboxesDatabaseId, mailboxItemId),
    syncState,
  );

  await storeCredential(client, {
    itemId: mailboxItemId,
    credentialType: account.provider === "icloud" ? "app_password" : "plain_password",
    plaintext: replacement.password,
  });
  await upsertMailServerSettings(client, mailboxItemId, {
    imap: replacement.verified.imap,
    smtp: replacement.verified.smtp,
    username: replacement.username ?? account.settings.username,
    caldavUrl: account.settings.caldavUrl,
  });
  await clearMailSyncFailure(client, mailboxItemId);
  await clearCalendarSyncReauthorization(client, mailboxItemId);
  await enqueueMailAccountSync(client, mailboxItemId);
  if (areCalendarsEnabled(account.mailbox.properties)) await enqueueCalendarAccountSync(client, mailboxItemId);
  const item = await getItemById(client, mailboxesDatabaseId, mailboxItemId);
  if (!item) throw new Error(`Mailbox ${mailboxItemId} is missing in the transaction that locked it`);
  return item;
}

/**
 * `PUT /api/mail/mailboxes/:id/password` signs an iCloud or generic mailbox in again with a new password, keeping its
 * mail, folders and threads. No transaction is open across the verification:
 *
 * 1. One transaction reads the account (404 `not_found` for an unknown, trashed or foreign id; 409
 *    `mailbox_not_password` for one that does not sign in with a password).
 * 2. The attempt is counted per user (429 `rate_limited`), as for the connect.
 * 3. Outside any transaction the login is verified against the stored IMAP and SMTP hosts, and on CalDAV when
 *    Calendars is on and the account has a CalDAV address; a refusal answers 400 with its code and changes nothing.
 * 4. One transaction checks the account again on locked rows, replaces the sealed password and the server settings,
 *    clears the mail failure record and a calendar `needsReauthorization`, and queues a mail sync and, with Calendars
 *    on, a calendar sync.
 * 5. After the commit the hosted live sync restarts, so it reads the new password.
 *
 * The password is in no response and no log line. `syncStatus` is left to the queued pass, its one writer.
 */
export function createMailboxPasswordReplaceRouteHandler(pool: Pool, dependencies: MailboxPasswordRouteDependencies) {
  return async (ctx: RouteParams & RouteBody & RouteUser): Promise<{ status: number; item: ItemRow }> => {
    const mailboxId = mailboxIdSchema.safeParse(ctx.params.id);
    if (!mailboxId.success) throw mailboxNotFound();
    const body = passwordBodySchema.safeParse(ctx.body);
    if (!body.success) {
      const field = body.error.issues[0]?.path[0];
      throw new ValidationError(
        "The body must hold a non-empty 'password' and may hold 'username'",
        typeof field === "string" ? { field } : undefined,
      );
    }
    const { password } = body.data;
    const username = body.data.username ?? null;
    // Read per request: a mount without a member must still start.
    const verifyPassword = requireVerifyPassword(dependencies);
    const throttle = requireThrottle(dependencies);
    const liveSync = requireLiveSync(dependencies);

    const account = await withTransaction(pool, async (client) => {
      const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
      return passwordAccountOf(
        client,
        await getItemById(client, mailboxesDatabaseId, mailboxId.data),
        await getMailAccountSyncState(client, mailboxId.data),
      );
    });
    const caldavUrl = areCalendarsEnabled(account.mailbox.properties) ? calDavUrlOf(account) : null;
    const verifyCalDav = caldavUrl === null ? null : requireVerifyCalDav(dependencies);
    const login = username ?? account.settings.username;

    // No `await` between the count and the call, so exactly the counted requests verify.
    const attempt = throttle.tryAcquire("mailboxCredentialVerification", ctx.identity.user.id);
    if (!attempt.granted) throw new RateLimitedError(attempt.retryAfterSeconds);

    let verified: VerifiedMailServerSettings;
    try {
      verified = await verifyPassword({
        provider: account.provider,
        address: account.address,
        username: login,
        password,
        ...(account.provider === "icloud"
          ? {}
          : { imapHost: account.settings.imap.host, smtpHost: account.settings.smtp.host }),
      });
    } catch (error) {
      if (isVerificationRefusal(error)) throw new ChokePointError(400, error.code, error.message);
      throw error;
    }
    if (verifyCalDav !== null && caldavUrl !== null) {
      try {
        await verifyCalDav({ caldavUrl, username: login, password });
      } catch (error) {
        if (isCalDavVerificationRefusal(error)) throw new ChokePointError(400, error.code, error.message);
        throw error;
      }
    }

    const item = await withTransaction(pool, (client) =>
      replaceMailboxPassword(client, { mailboxItemId: mailboxId.data, password, username, verified }),
    );
    await liveSync.restartAccount(mailboxId.data);
    return { status: 200, item };
  };
}
