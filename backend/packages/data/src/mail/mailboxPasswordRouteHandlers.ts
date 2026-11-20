import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { NEW_MAILBOX_SERVICE_SWITCHES } from "./mailboxServiceHooks.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { withTransaction } from "../db/pool.js";
import { ChokePointError, RateLimitedError, ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";
import { parseAddressListProperty } from "./addressListParsing.js";
import {
  ensureMailAccountSyncState,
  ProviderAccountAlreadyConnectedError,
  recordProviderAccountAddress,
} from "./mailAccountSyncStateStore.js";
import { writeMailboxAddresses } from "./mailboxAddresses.js";
import type { VerifiedMailServerSettings, VerifyMailCredentialsInput } from "./mailCredentialVerification.js";
import { resolveMailModuleIds } from "./mailModuleIds.js";
import { normalizeCalDavUrl, normalizeMailServerHost, upsertMailServerSettings } from "./mailServerSettingsStore.js";
import { enqueueMailAccountSync } from "./mailSyncEnqueue.js";
import { normalizeEmailAddress } from "./personEmailIndexStore.js";
import {
  MailAppPasswordRequiredError,
  MailAuthFailedError,
  MailServerUnreachableError,
  MailTlsFailedError,
} from "./providerTypes.js";
import type { RouteBody, RouteUser } from "../customRoute.js";
import {
  isCalDavVerificationRefusal,
  type VerifyCalDavServerInput,
} from "../calendar/sync/adapters/caldav/caldavConnectVerification.js";

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

/**
 * A trashed mailbox counts, because the unique index on the recorded address counts its sync state row
 * too. The reads take no row lock: the write transaction rechecks at READ COMMITTED.
 */
async function mailboxHoldsAddress(client: PoolClient, mailboxesDatabaseId: string, address: string): Promise<boolean> {
  const normalized = normalizeEmailAddress(address);
  const recorded = await client.query<{ item_id: string }>(
    "SELECT item_id FROM mail_account_sync_state WHERE provider_account_address = $1",
    [normalized],
  );
  if (recorded.rows.length > 0) return true;
  const listed = await client.query<{ addresses: string | null }>(
    "SELECT properties->>'addresses' AS addresses FROM items WHERE database_id = $1",
    [mailboxesDatabaseId],
  );
  return listed.rows.some((row) =>
    parseAddressListProperty(row.addresses).some((entry) => normalizeEmailAddress(entry) === normalized),
  );
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
