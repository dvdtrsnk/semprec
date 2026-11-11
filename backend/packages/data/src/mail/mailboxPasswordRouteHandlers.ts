import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { loadModuleCatalogs, resolveCatalogLabel } from "@semprec/module-registry";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { withTransaction } from "../db/pool.js";
import { ChokePointError, ValidationError } from "../errors.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
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
import { normalizeMailServerHost, upsertMailServerSettings } from "./mailServerSettingsStore.js";
import { enqueueMailAccountSync } from "./mailSyncEnqueue.js";
import { normalizeEmailAddress } from "./personEmailIndexStore.js";
import {
  MailAppPasswordRequiredError,
  MailAuthFailedError,
  MailServerUnreachableError,
  MailTlsFailedError,
} from "./providerTypes.js";

/** The providers a mailbox is connected to with a password; Gmail and Outlook sign in through OAuth instead. */
const PASSWORD_MAILBOX_PROVIDERS = ["icloud", "generic"] as const;
type PasswordMailboxProvider = (typeof PASSWORD_MAILBOX_PROVIDERS)[number];

/** The longest user name `upsertMailServerSettings` stores; the address is the default user name, so it shares the bound. */
const MAX_ADDRESS_LENGTH = 320;
const MAX_USERNAME_LENGTH = 320;
/** Far above any password a mail provider issues; bounds what is sealed and sent to the mail server. */
const MAX_PASSWORD_LENGTH = 1024;

/**
 * One address without whitespace or a comma: `Mailboxes.addresses` separates its entries by line breaks and
 * commas (`parseAddressListProperty`), so an address that held one would be read back as two entries.
 */
const ADDRESS_PATTERN = /^[^\s@,]+@[^\s@,]+$/;

/**
 * A control character (general category Cc: U+0000 to U+001F and U+007F to U+009F) or an unpaired
 * surrogate (Cs; with the `u` flag a surrogate pair is one character of another category).
 */
const UNSTORABLE_CHARACTER = /[\p{Cc}\p{Cs}]/u;

/**
 * Whether Postgres stores `value` as it was sent. `text` and `jsonb` refuse U+0000, `jsonb` refuses an
 * unpaired surrogate, and one bound as `text` arrives as U+FFFD. The address is bound to statements as
 * both types and the user name as `text`, so a value that held either character would fail a statement,
 * or be stored changed, after it passed the body validation. No address and no login name holds any
 * other control character.
 */
function isStorableText(value: string): boolean {
  return !UNSTORABLE_CHARACTER.test(value);
}

const connectBodySchema = z
  .object({
    provider: z.enum(PASSWORD_MAILBOX_PROVIDERS),
    address: z.string().trim().max(MAX_ADDRESS_LENGTH).regex(ADDRESS_PATTERN).refine(isStorableText),
    // Any character is accepted: `storeCredential` binds the sealed bytes to its statement, never this text.
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
    // Validated by `normalizeMailServerHost`, which accepts the letters, digits and hyphens of a DNS name only.
    imapHost: z.string().optional(),
    smtpHost: z.string().optional(),
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
  /** The address as the caller typed it, without surrounding whitespace. */
  address: string;
  username: string;
  password: string;
  /** The normalized hosts of a generic mailbox; `null` for iCloud, whose hosts `verifyMailCredentials` fixes. */
  hosts: { imapHost: string; smtpHost: string } | null;
}

/**
 * Validates the request body. Every refusal is a 400 `validation_failed` that names the field when one
 * field is at fault, and no message repeats a value of the body. The user name defaults to the address.
 */
function parseConnectRequest(body: unknown): ConnectRequest {
  const parsed = connectBodySchema.safeParse(body);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    throw new ValidationError(
      "The body must hold 'provider', 'address' and 'password', and may hold 'username', 'imapHost' and 'smtpHost'",
      typeof field === "string" ? { field } : undefined,
    );
  }
  const { provider, address, password, imapHost, smtpHost } = parsed.data;
  const username = parsed.data.username ?? address;
  if (provider === "icloud") {
    if (imapHost !== undefined) {
      throw new ValidationError("imapHost is not accepted for an iCloud mailbox", { field: "imapHost" });
    }
    if (smtpHost !== undefined) {
      throw new ValidationError("smtpHost is not accepted for an iCloud mailbox", { field: "smtpHost" });
    }
    return { provider, address, username, password, hosts: null };
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
  };
}

/**
 * The new mailbox's name, which the user can change afterwards: the catalog entry
 * `mail.mailbox.defaultName.<provider>` of `mail/i18n`, in the caller's locale.
 */
async function defaultMailboxName(provider: PasswordMailboxProvider, locale: string): Promise<string> {
  const catalogs = await loadModuleCatalogs(import.meta.url);
  return resolveCatalogLabel(
    null,
    catalogs[toManifestLocale(locale)],
    catalogs.en,
    `mail.mailbox.defaultName.${provider}`,
  );
}

/**
 * Whether a mailbox of the caller's tenant already holds `address`: its sync state records it as the
 * provider account address, or its `addresses` list names it. Both sides are compared after
 * `normalizeEmailAddress`, and the list is split by `parseAddressListProperty` like every other reader of
 * that property. A trashed mailbox counts, because the unique index on the recorded address counts its
 * sync state row too. The reads take no row lock
 * (docs/adr/2026-11-10-password-mailbox-connect-rechecks-its-duplicate-rule-at-read-committed.md).
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

/** The four outcomes `verifyMailCredentials` reports about the caller's server or password. */
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
 * Everything a password mailbox consists of, written in the caller's transaction: the Mailboxes item,
 * its address, the sealed password, the server settings that passed the verification, the sync state
 * with the provider account address and a queued first sync. The duplicate rule is read again first.
 * `recordProviderAccountAddress` refuses an address a concurrent request recorded meanwhile; Postgres
 * has aborted the transaction by then, so the caller rolls it back.
 */
async function createPasswordMailbox(client: PoolClient, mailbox: NewPasswordMailbox): Promise<ItemRow> {
  const { request } = mailbox;
  const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
  if (await mailboxHoldsAddress(client, mailboxesDatabaseId, request.address)) {
    throw new ProviderAccountAlreadyConnectedError();
  }
  const created = await createItemWithClient(
    client,
    { databaseId: mailboxesDatabaseId, properties: { name: mailbox.name, provider: request.provider } },
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
  });
  await ensureMailAccountSyncState(client, { itemId: created.id, syncMode: "imap" });
  await recordProviderAccountAddress(client, created.id, request.address);
  await enqueueMailAccountSync(client, created.id);
  // Read back after the address write, so the response shows the item as this transaction leaves it.
  const item = await getItemById(client, mailboxesDatabaseId, created.id);
  if (!item) throw new Error(`Mailbox ${created.id} is missing in the transaction that created it`);
  return item;
}

/** The shape of `verifyMailCredentials`: resolves with the endpoints that accepted the login, rejects when none did. */
type VerifyPassword = (input: VerifyMailCredentialsInput) => Promise<VerifiedMailServerSettings>;

/**
 * The member of the composition root's custom-route container this route reads
 * (docs/adr/2026-10-29-custom-route-composition-root-dependencies.md). `semprec-api`'s
 * `CustomRouteDependencies` is assignable to it.
 */
export interface MailboxPasswordRouteDependencies {
  mailServerClients?: {
    /**
     * Verifies the login on both protocols. The composition root sets it to `verifyMailCredentials`
     * (`services/semprec-api/src/serve.ts`). The route has no verification of its own to fall back on.
     */
    verifyPassword?: VerifyPassword;
  };
}

/**
 * The verification the composition root configured. A root that configured none fails the request with a
 * plain error and not a `ChokePointError`, as
 * docs/adr/2026-10-29-custom-route-composition-root-dependencies.md decides for a member that is not set:
 * the deployment is missing configuration, so the adapter logs the error and answers a generic 500.
 */
function requireVerifyPassword(dependencies: MailboxPasswordRouteDependencies): VerifyPassword {
  const verifyPassword = dependencies.mailServerClients?.verifyPassword;
  if (!verifyPassword) {
    throw new Error(
      'custom route dependency "mailServerClients.verifyPassword" is not configured by the composition root',
    );
  }
  return verifyPassword;
}

interface MailboxPasswordRouteContext {
  identity: { user: { id: string; locale: string } };
  body: unknown;
}

/**
 * `POST /api/mail/mailboxes` (issue gh-1736): connects an iCloud mailbox (address and app-specific
 * password) or a generic IMAP mailbox (address, password, IMAP and SMTP host) and answers 201 with the
 * new Mailboxes item. No transaction is open across the verification, as
 * docs/adr/2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions.md requires;
 * docs/adr/2026-11-10-password-mailbox-connect-rechecks-its-duplicate-rule-at-read-committed.md records
 * the isolation level and the absence of a row lock.
 *
 * 1. The body is validated; `imapHost` and `smtpHost` are required for `generic` and refused for `icloud`.
 * 2. The verification is read from the container (`mailServerClients.verifyPassword`, which `serve.ts` sets
 *    to `verifyMailCredentials`). A composition root that configured none fails the request here with a
 *    plain error, so the adapter answers a generic 500.
 * 3. One transaction reads the duplicate rule: an address a mailbox of the tenant already holds answers
 *    409 `provider_account_already_connected` before any server is contacted.
 * 4. Outside any transaction that verification checks the login on both protocols. A refusal answers 400
 *    with the verification's own code (`mail_auth_failed`, `mail_app_password_required`,
 *    `mail_server_unreachable`, `mail_tls_failed`). Every other failure propagates unchanged, so the
 *    adapter answers a generic 500. Nothing has been written at that point.
 * 5. One transaction reads the duplicate rule again and writes the mailbox (`createPasswordMailbox`). A
 *    mailbox that came to hold the address meanwhile answers 409, and the transaction rolls back whole:
 *    no item, credential, server settings, sync state row or job of the refused mailbox remains.
 *
 * The password is sealed by `storeCredential` and is in no response and no log line of this route.
 */
export function createMailboxPasswordConnectRouteHandler(pool: Pool, dependencies: MailboxPasswordRouteDependencies) {
  return async (ctx: MailboxPasswordRouteContext): Promise<{ status: number; item: ItemRow }> => {
    const request = parseConnectRequest(ctx.body);
    // Read per request and never while the factory runs: a mount without the member must still start.
    const verifyPassword = requireVerifyPassword(dependencies);
    const name = await defaultMailboxName(request.provider, ctx.identity.user.locale);

    await withTransaction(pool, async (client) => {
      const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
      if (await mailboxHoldsAddress(client, mailboxesDatabaseId, request.address)) {
        throw new ProviderAccountAlreadyConnectedError();
      }
    });

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
      // 400 is the status the REST error contract assigns these four codes (`ITEM_ERROR_STATUS_BY_CODE`).
      if (isVerificationRefusal(error)) throw new ChokePointError(400, error.code, error.message);
      throw error;
    }

    const item = await withTransaction(pool, (client) =>
      createPasswordMailbox(client, { request, name, verified, userId: ctx.identity.user.id }),
    );
    return { status: 201, item };
  };
}
