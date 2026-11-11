import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemById, lockItemById } from "../chokePoint/itemsStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { withTransaction } from "../db/pool.js";
import { ChokePointError, NotFoundError, ValidationError } from "../errors.js";
import { MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import type { ItemRow } from "../types.js";
import {
  defaultSyncModeForProvider,
  ensureMailAccountSyncState,
  findMailboxByProviderAccountAddress,
  getMailAccountSyncState,
  getProviderAccountAddress,
  lockMailAccountSyncState,
  ProviderAccountAlreadyConnectedError,
  recordGmailWatchEmailAddress,
  recordProviderAccountAddress,
  type MailAccountSyncStateRow,
} from "./mailAccountSyncStateStore.js";
import { writeMailboxAddresses } from "./mailboxAddresses.js";
import { resolveMailModuleIds } from "./mailModuleIds.js";
import {
  consumeMailOauthState,
  createMailOauthState,
  MAIL_OAUTH_PROVIDERS,
  type CreatedMailOauthState,
  type MailOauthProvider,
} from "./mailOauthStatesStore.js";
import { enqueueMailAccountSync } from "./mailSyncEnqueue.js";
import { normalizeEmailAddress } from "./personEmailIndexStore.js";
import {
  exchangeAuthorizationCode,
  GOOGLE_TOKEN_URL,
  MICROSOFT_TOKEN_URL,
  type AuthorizationCodeTokens,
} from "./oauthTokenExchange.js";
import {
  assertJsonObject,
  MailAdminConsentRequiredError,
  MailAuthorizationCodeRejectedError,
} from "./providerTypes.js";

/**
 * The path the provider redirects the browser back to (issue gh-1686). `semprec-api` serves it
 * without a session (`mailOauthCallbackHandler.ts`); the redirect URI sent to the provider is this
 * path on the composition root's redirect base URL, in the authorization request and in the code
 * exchange alike.
 */
const MAIL_OAUTH_CALLBACK_PATH = "/api/mail/oauth/callback";

interface MailOauthProviderSettings {
  /** The new mailbox's name: the provider's product name, which the user can change afterwards. */
  mailboxName: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** The least that reading, triage, drafting and sending need. */
  scopes: readonly string[];
  /** Provider-specific parameters of the authorization request. */
  authorizeParams: Readonly<Record<string, string>>;
}

const PROVIDER_SETTINGS: Record<MailOauthProvider, MailOauthProviderSettings> = {
  gmail: {
    mailboxName: "Gmail",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: GOOGLE_TOKEN_URL,
    // `gmail.modify` includes read access.
    scopes: ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.send"],
    // `offline` asks for a refresh token; `consent` makes Google return one again on a repeated sign-in.
    authorizeParams: { access_type: "offline", prompt: "consent" },
  },
  outlook: {
    mailboxName: "Outlook",
    // `/common` accepts work or school accounts and personal Microsoft accounts.
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: MICROSOFT_TOKEN_URL,
    // `User.Read` is what lets `GET /me` answer; without it Graph answers 403.
    scopes: ["Mail.ReadWrite", "Mail.Send", "offline_access", "User.Read"],
    authorizeParams: {},
  },
};

interface MailOauthClient {
  clientId: string;
  clientSecret: string;
}

/**
 * The members of the composition root's custom-route container these routes read
 * (docs/adr/2026-10-29-custom-route-composition-root-dependencies.md). `semprec-api`'s
 * `CustomRouteDependencies` is assignable to it.
 */
export interface MailOauthRouteDependencies {
  oauth?: {
    gmail?: MailOauthClient;
    msGraph?: MailOauthClient;
    redirectBaseUrl?: string;
  };
  /** Replaces the global `fetch` for the calls to the provider. */
  outboundHttp?: typeof fetch;
  /** The mail live-sync root's per-mailbox restart, which a reauthorization calls after its commit (issue gh-1742). */
  mailLiveSync?: { restartAccount(mailboxItemId: string): Promise<void> };
}

interface MailOauthRouteContext {
  identity: { user: { id: string } };
  body: unknown;
}

type MailOauthRouteResult = { status: number; body: unknown };

/**
 * The provider's OAuth client and the redirect URI, read per request. A deployment that did not
 * configure them fails the request with a plain error, which the adapter answers with a generic 500.
 */
function requireOauthClient(
  dependencies: MailOauthRouteDependencies,
  provider: MailOauthProvider,
): { client: MailOauthClient; redirectUri: string } {
  const oauth = dependencies.oauth;
  const client = provider === "gmail" ? oauth?.gmail : oauth?.msGraph;
  if (!client || !oauth?.redirectBaseUrl) {
    throw new Error(`Mail OAuth for provider "${provider}" is not configured by the composition root`);
  }
  return { client, redirectUri: new URL(MAIL_OAUTH_CALLBACK_PATH, oauth.redirectBaseUrl).toString() };
}

function buildAuthorizeUrl(
  provider: MailOauthProvider,
  clientId: string,
  redirectUri: string,
  created: CreatedMailOauthState,
): string {
  const settings = PROVIDER_SETTINGS[provider];
  const url = new URL(settings.authorizeUrl);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: settings.scopes.join(" "),
    state: created.state,
    code_challenge: created.codeChallenge,
    code_challenge_method: "S256",
    ...settings.authorizeParams,
  }).toString();
  return url.toString();
}

const startBodySchema = z.object({ provider: z.enum(MAIL_OAUTH_PROVIDERS) }).strict();

/**
 * `POST /api/mail/mailboxes/oauth/start` (issue gh-1686): creates a one-time state for a new mailbox
 * of the calling user and answers the provider's authorization URL, carrying the S256 code challenge,
 * the state, the redirect URI and the scopes of `PROVIDER_SETTINGS`. The verifier stays sealed in the
 * state row; the response holds the URL and nothing else.
 */
export function createMailOauthStartRouteHandler(pool: Pool, dependencies: MailOauthRouteDependencies) {
  return async (ctx: MailOauthRouteContext): Promise<MailOauthRouteResult> => {
    const body = startBodySchema.safeParse(ctx.body);
    if (!body.success) {
      throw new ValidationError("'provider' must be 'gmail' or 'outlook'", { field: "provider" });
    }
    const { provider } = body.data;
    const { client, redirectUri } = requireOauthClient(dependencies, provider);
    const created = await withTransaction(pool, (transaction) =>
      createMailOauthState(transaction, { userId: ctx.identity.user.id, provider, mailboxItemId: null }),
    );
    return { status: 200, body: { authorizeUrl: buildAuthorizeUrl(provider, client.clientId, redirectUri, created) } };
  };
}

function isMailOauthProvider(value: unknown): value is MailOauthProvider {
  return typeof value === "string" && (MAIL_OAUTH_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The Mailboxes item `mailboxItemId` of the caller's tenant, or `null` when it is unknown,
 * soft-deleted or another tenant's (row-level security hides it), or the tenant has no Mailboxes
 * database. Each of those reads the same. With `lock` the row is locked for the caller's transaction.
 */
async function liveMailbox(client: PoolClient, mailboxItemId: string, lock: boolean): Promise<ItemRow | null> {
  const mailboxesDatabase = await getDatabaseByModuleId(client, MAILBOXES_MODULE_ID);
  if (mailboxesDatabase === null) return null;
  const mailbox = await (lock ? lockItemById : getItemById)(client, mailboxesDatabase.id, mailboxItemId);
  return mailbox === null || mailbox.deletedAt !== null ? null : mailbox;
}

/**
 * The provider a mailbox signs in at again (issue gh-1742), or `null` for a mailbox that cannot be
 * reauthorized. Two things must hold:
 *
 * - The mailbox's `provider` property is `gmail` or `outlook`.
 * - The mailbox syncs through that provider's API. `mail_account_sync_state.sync_mode` is what the
 *   sync job and the hosted lifecycles dispatch on, so it decides where the stored credential is
 *   sent, and `ensureMailAccountSyncState` never changes it on an existing row. `syncState` is
 *   `null` for a mailbox without a row; it gets one with the mode of its `provider`, from the
 *   completion or from a discovery pass.
 *
 * The property alone does not decide, because the user owns it and a generic item write changes it.
 * An IMAP mailbox relabelled `gmail` still presents its stored credential as its IMAP password, and
 * a Gmail mailbox relabelled `outlook` still sends its own to Google's token endpoint. Replacing
 * either credential with the refresh token of the provider the label names would break the mailbox
 * and hand that token to a server it was not issued for.
 */
function reauthorizationProvider(
  mailbox: ItemRow,
  syncState: MailAccountSyncStateRow | null,
): MailOauthProvider | null {
  const provider = mailbox.properties.provider;
  if (!isMailOauthProvider(provider)) return null;
  if (syncState !== null && syncState.syncMode !== defaultSyncModeForProvider(provider)) return null;
  return provider;
}

interface MailboxReauthorizeRouteContext {
  identity: { user: { id: string } };
  params: Record<string, string>;
}

/** `items.id` is a uuid: a malformed id names no mailbox, so it gets the same 404 as an unknown one. */
const mailboxIdSchema = z.uuid();

/**
 * `POST /api/mail/mailboxes/:id/reauthorize` (issue gh-1742): starts a new sign-in for an existing
 * Gmail or Outlook mailbox of the calling user's tenant. It answers the provider's authorization URL,
 * built like the start route's, for a one-time state that carries the mailbox id; the complete route
 * then replaces that mailbox's refresh token instead of creating a mailbox.
 *
 * The mailbox is read, with a row lock, in the transaction that stores the state. An unknown,
 * soft-deleted or foreign mailbox answers the same 404 `not_found`. A mailbox that
 * `reauthorizationProvider` names no provider for answers 400 `validation_failed`: one whose
 * `provider` is neither `gmail` nor `outlook`, which signs in with a password, and one whose sync
 * state row holds another sync mode than its `provider`'s, an IMAP mailbox relabelled `gmail`
 * included. A deployment without the provider's OAuth client fails with a plain error, as the start
 * route does. None of them stores a state.
 *
 * The sync state row is read without a lock, so this refusal is the route's early answer and no
 * guard: a row can be seeded after the read. The completion decides again under the row's lock
 * (`replaceMailboxCredential`). Locking the row here, after the Mailboxes item, would also take the
 * two rows in the opposite order to the completion and the sync job.
 */
export function createMailboxReauthorizeRouteHandler(pool: Pool, dependencies: MailOauthRouteDependencies) {
  return async (ctx: MailboxReauthorizeRouteContext): Promise<MailOauthRouteResult> => {
    const mailboxId = mailboxIdSchema.safeParse(ctx.params.id);
    if (!mailboxId.success) throw new NotFoundError("Mailbox not found");
    const authorizeUrl = await withTransaction(pool, async (transaction) => {
      const mailbox = await liveMailbox(transaction, mailboxId.data, true);
      if (mailbox === null) throw new NotFoundError("Mailbox not found");
      const syncState = await getMailAccountSyncState(transaction, mailboxId.data);
      const provider = reauthorizationProvider(mailbox, syncState);
      if (provider === null) {
        throw new ValidationError(
          "This mailbox cannot sign in again: it signs in with a password, or its 'provider' is not the one it syncs with",
          { field: "provider" },
        );
      }
      const { client, redirectUri } = requireOauthClient(dependencies, provider);
      const created = await createMailOauthState(transaction, {
        userId: ctx.identity.user.id,
        provider,
        mailboxItemId: mailboxId.data,
      });
      return buildAuthorizeUrl(provider, client.clientId, redirectUri, created);
    });
    return { status: 200, body: { authorizeUrl } };
  };
}

const PROVIDER_TIMEOUT_MS = 15_000;
/** A Gmail send-as list carries every alias's HTML signature, so the cap is well above a token response's. */
const PROVIDER_RESPONSE_LIMIT_BYTES = 1024 * 1024;
/** More aliases than a provider account holds; bounds what one response can put on the mailbox. */
const MAX_ALIASES = 100;

const GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const GMAIL_SEND_AS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs";
/** Graph returns `proxyAddresses` only when `$select` names it, so the request names all three properties it reads. */
const GRAPH_ME_URL = "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,proxyAddresses";
/** The type prefix of an SMTP entry in `proxyAddresses`: `SMTP:` on the primary address, `smtp:` on a secondary one. */
const SMTP_PROXY_ADDRESS_PREFIX = /^smtp:/i;

/** One address without whitespace: what the provider's answer must look like before it is stored. */
const ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+$/;

function isAddress(value: unknown): value is string {
  return typeof value === "string" && ADDRESS_PATTERN.test(value.trim());
}

/**
 * One authenticated `GET` to the provider, answered as a JSON object. The request is aborted after
 * `PROVIDER_TIMEOUT_MS` and on every way out, and the body is read up to
 * `PROVIDER_RESPONSE_LIMIT_BYTES`. No thrown message holds the access token or the response body.
 */
async function getProviderJson(
  fetchImpl: typeof fetch,
  url: string,
  accessToken: string,
  what: string,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        signal: controller.signal,
      });
    } catch {
      // The cause can describe the request, whose header holds the access token.
      throw new Error(`${what} request failed`);
    }
    if (!response.ok) throw new Error(`${what} request failed with status ${response.status}`);
    const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
    if (!reader) throw new Error(`${what} response has no body`);
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await reader.read();
      } catch {
        // A stream failure is raised by the transport, whose text this function does not control.
        throw new Error(`${what} response could not be read`);
      }
      if (result.done) break;
      length += result.value.byteLength;
      if (length > PROVIDER_RESPONSE_LIMIT_BYTES) throw new Error(`${what} response exceeds the size limit`);
      chunks.push(result.value);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error(`${what} response is not valid JSON`);
    }
    return assertJsonObject(parsed, `${what} response`);
  } finally {
    clearTimeout(timer);
    // Releases the connection of a response that was not read to its end.
    controller.abort();
  }
}

interface ProviderIdentity {
  /** The account's own address, as the provider reports it. */
  address: string;
  aliases: string[];
}

/**
 * Gmail: the account address from `users.getProfile` and its aliases from `settings.sendAs`. An alias
 * counts when Gmail marks it primary or verified (`accepted`): anybody can add a pending address.
 */
async function fetchGmailIdentity(fetchImpl: typeof fetch, accessToken: string): Promise<ProviderIdentity> {
  const profile = await getProviderJson(fetchImpl, GMAIL_PROFILE_URL, accessToken, "Gmail profile");
  if (!isAddress(profile.emailAddress)) throw new Error("Gmail profile response holds no account address");
  const sendAs = await getProviderJson(fetchImpl, GMAIL_SEND_AS_URL, accessToken, "Gmail send-as list");
  const entries: unknown = sendAs.sendAs ?? [];
  if (!Array.isArray(entries)) throw new Error("Gmail send-as list response holds no list");
  const aliases: string[] = [];
  for (const entry of entries as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { sendAsEmail, isPrimary, verificationStatus } = entry as Record<string, unknown>;
    if (isAddress(sendAsEmail) && (isPrimary === true || verificationStatus === "accepted")) aliases.push(sendAsEmail);
  }
  return { address: profile.emailAddress, aliases: aliases.slice(0, MAX_ALIASES) };
}

/**
 * Microsoft Graph: the account address and its aliases from `GET /me`. `mail` is the mailbox
 * address; an account that reports none is known by `userPrincipalName`. `proxyAddresses` lists every
 * address tied to the mailbox of a work or school account, each behind its type prefix, and the
 * SMTP entries are the aliases; entries of another type (`X500:`, `SIP:`) are no mail addresses.
 *
 * A personal Microsoft account has no such list. Microsoft's reference does not say how it answers
 * the `$select`; such accounts are reported to answer the default property set, or the list empty.
 * Both carry the address and read as an account without aliases, so a missing list is no error.
 */
async function fetchGraphIdentity(fetchImpl: typeof fetch, accessToken: string): Promise<ProviderIdentity> {
  const me = await getProviderJson(fetchImpl, GRAPH_ME_URL, accessToken, "Microsoft Graph profile");
  const address = [me.mail, me.userPrincipalName].find(isAddress);
  if (address === undefined) throw new Error("Microsoft Graph profile response holds no account address");
  const entries: unknown = me.proxyAddresses ?? [];
  if (!Array.isArray(entries)) throw new Error("Microsoft Graph profile response holds no proxy address list");
  const aliases: string[] = [];
  for (const entry of entries as unknown[]) {
    if (typeof entry !== "string" || !SMTP_PROXY_ADDRESS_PREFIX.test(entry)) continue;
    const alias = entry.replace(SMTP_PROXY_ADDRESS_PREFIX, "");
    if (isAddress(alias)) aliases.push(alias);
  }
  return { address, aliases: aliases.slice(0, MAX_ALIASES) };
}

interface NewMailbox {
  provider: MailOauthProvider;
  identity: ProviderIdentity;
  refreshToken: string;
  userId: string;
}

/**
 * Everything a connected mailbox consists of, written in the caller's transaction: the Mailboxes
 * item, its addresses, the sealed refresh token, the sync state with the provider account address
 * and a queued first sync. `recordProviderAccountAddress` refuses an address another mailbox of the
 * tenant already records; Postgres has aborted the transaction by then, so the caller rolls it back.
 */
async function createConnectedMailbox(client: PoolClient, mailbox: NewMailbox): Promise<string> {
  const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
  const item = await createItemWithClient(
    client,
    {
      databaseId: mailboxesDatabaseId,
      properties: { name: PROVIDER_SETTINGS[mailbox.provider].mailboxName, provider: mailbox.provider },
    },
    { actingUserId: mailbox.userId, writer: { writerKind: "user" } },
  );
  await writeMailboxAddresses(client, {
    mailboxesDatabaseId,
    mailboxItemId: item.id,
    address: mailbox.identity.address,
    aliases: mailbox.identity.aliases,
  });
  await storeCredential(client, {
    itemId: item.id,
    credentialType: "oauth2_refresh_token",
    plaintext: mailbox.refreshToken,
  });
  await ensureMailAccountSyncState(client, {
    itemId: item.id,
    syncMode: defaultSyncModeForProvider(mailbox.provider),
  });
  await recordProviderAccountAddress(client, item.id, mailbox.identity.address);
  if (mailbox.provider === "gmail") {
    await recordGmailWatchEmailAddress(client, item.id, mailbox.identity.address);
  }
  await enqueueMailAccountSync(client, item.id);
  return item.id;
}

/** The account that signed in is not the one the mailbox is connected to (issue gh-1742). */
function wrongAccountError(): ChokePointError {
  return new ChokePointError(
    400,
    "mail_reauth_wrong_account",
    "The account that signed in is not the account this mailbox is connected to",
  );
}

interface Reauthorization {
  mailboxItemId: string;
  provider: MailOauthProvider;
  /** The signed-in account's own address, as the provider reports it. */
  address: string;
  refreshToken: string;
}

/**
 * Replaces the refresh token of an existing mailbox and queues its sync, in the caller's transaction
 * (issue gh-1742). Every condition is read in this transaction, under the row locks it takes:
 *
 * - The mailbox must still be a live Mailboxes item that signs in at the state's provider: its
 *   `provider` property names it and its sync state row holds that provider's sync mode
 *   (`reauthorizationProvider`). Otherwise the state names nothing to reauthorize any more and the
 *   call fails with 400 `validation_failed`. This keeps the password of an IMAP mailbox relabelled
 *   `gmail` or `outlook`, and the token of a mailbox relabelled from one of the two to the other.
 * - The signed-in address must be the mailbox's stored provider account address. When none is
 *   stored, the address is recorded; `recordProviderAccountAddress` refuses one that another mailbox
 *   of the tenant records, and Postgres has aborted the transaction by then.
 *
 * The sync state row is locked before the Mailboxes item, the order in which the sync job's
 * transactions take the same two rows (its sync state update, then its `syncStatus` write). A
 * mailbox no discovery pass has seeded yet gets its sync state row here, before either lock.
 * `Mailboxes.syncStatus`, the history cursor and the delta link are not written.
 */
async function replaceMailboxCredential(client: PoolClient, reauthorization: Reauthorization): Promise<void> {
  const { mailboxItemId, provider } = reauthorization;
  const staleState = (): ValidationError =>
    new ValidationError("The sign-in state names no mailbox of its provider any more", { field: "state" });

  // Unlocked, so no guard of the write: it keeps the next statement from running for an id that is
  // no mailbox of this tenant. For another tenant's mailbox that statement would collide with that
  // tenant's row, which row-level security hides, and fail with an unexpected error.
  const unlocked = await liveMailbox(client, mailboxItemId, false);
  if (unlocked === null || unlocked.properties.provider !== provider) throw staleState();
  // Leaves an existing row as it is, its sync mode included.
  await ensureMailAccountSyncState(client, { itemId: mailboxItemId, syncMode: defaultSyncModeForProvider(provider) });
  const syncState = await lockMailAccountSyncState(client, mailboxItemId);
  const mailbox = await liveMailbox(client, mailboxItemId, true);
  if (mailbox === null || reauthorizationProvider(mailbox, syncState) !== provider) throw staleState();

  const stored = await getProviderAccountAddress(client, mailboxItemId);
  if (stored === null) {
    await recordProviderAccountAddress(client, mailboxItemId, reauthorization.address);
  } else if (stored !== normalizeEmailAddress(reauthorization.address)) {
    throw wrongAccountError();
  }
  await storeCredential(client, {
    itemId: mailboxItemId,
    credentialType: "oauth2_refresh_token",
    plaintext: reauthorization.refreshToken,
  });
  await enqueueMailAccountSync(client, mailboxItemId);
}

/**
 * The live-sync root's restart control, read when a reauthorization runs. A deployment that did not
 * configure it fails the request with a plain error, which the adapter answers with a generic 500.
 */
function requireLiveSync(
  dependencies: MailOauthRouteDependencies,
): NonNullable<MailOauthRouteDependencies["mailLiveSync"]> {
  if (!dependencies.mailLiveSync) {
    throw new Error("The mail live-sync restart is not configured by the composition root");
  }
  return dependencies.mailLiveSync;
}

/** Lengths far above what a provider issues; they bound what reaches the hash and the token request. */
const completeBodySchema = z
  .object({
    state: z.string().min(1).max(512),
    code: z.string().min(1).max(4096),
  })
  .strict();

/**
 * `POST /api/mail/mailboxes/oauth/complete` (issue gh-1686): turns the state and the authorization
 * code the provider handed back into a connected mailbox. No transaction is open across the provider
 * call, as docs/adr/2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions.md
 * requires. The rest departs from that decision's snapshot read and re-validating write, and
 * docs/adr/2026-11-10-mailbox-oauth-connect-consumes-its-state-before-the-provider-call.md records
 * how and why: the steps below, their isolation level and the write of the Gmail watch address.
 *
 * 1. One transaction consumes the state for the calling user and commits. A state of another user or
 *    tenant, a used one and an expired one answer the same 400 `validation_failed`. The state stays
 *    consumed whatever happens next, so a failed sign-in starts over. It runs at the default
 *    isolation level, because the consumption is one guarded statement and the loser of a race must
 *    read "no row", not a serialization failure.
 * 2. Outside any transaction the code is exchanged and the provider is asked for the account's own
 *    address and aliases. A code the token endpoint refuses as `invalid_grant` answers 400
 *    `validation_failed`, and a Microsoft tenant that needs administrator approval 400
 *    `mail_admin_consent_required`. Every other failure propagates as an unexpected error, a
 *    refusal of the OAuth client itself (`invalid_client`) included, so the adapter logs it and
 *    answers a generic 500. Nothing has been created at that point.
 * 3. One transaction writes the mailbox (`createConnectedMailbox`) and re-validates nothing, because
 *    no value read before the provider call decides the write. Whether another mailbox of the
 *    tenant records the same address is not read beforehand: the unique index behind
 *    `recordProviderAccountAddress` decides it inside this transaction, which then rolls back
 *    whole. The route reads that mailbox's id in a further transaction and answers 409
 *    `provider_account_already_connected` with it, or with `null` when no mailbox records the
 *    address any more.
 *
 * The response holds the new mailbox's id. No token, code or verifier is logged or returned. The
 * live-sync root hosts the mailbox on its next discovery pass.
 *
 * A state that carries a mailbox id reauthorizes that mailbox instead (issue gh-1742,
 * docs/adr/2026-11-11-mailbox-reauthorization-restarts-the-hosted-lifecycle-in-the-live-sync-roots-context.md).
 * Steps 1 and 2 are the same, except that a deployment without the live-sync restart fails right
 * after step 1. Step 3 is replaced:
 *
 * 3. One transaction (`replaceMailboxCredential`) checks, under row locks, that the mailbox still
 *    exists and that the signed-in address is the mailbox's stored provider account address, then
 *    replaces the refresh token and queues a sync. Another account answers 400
 *    `mail_reauth_wrong_account` and changes nothing; so does an account that another mailbox of
 *    the tenant records, when this mailbox records none. A mailbox that is gone, changed its
 *    provider or does not sync through the provider's API answers 400 `validation_failed` for the
 *    state.
 * 4. After the commit the live-sync root restarts the mailbox's hosted lifecycle, so it reads the
 *    new token. A failure of that call propagates as an unexpected error, with the token already
 *    replaced and the sync queued. The response is 200 with the mailbox's id.
 */
export function createMailOauthCompleteRouteHandler(pool: Pool, dependencies: MailOauthRouteDependencies) {
  return async (ctx: MailOauthRouteContext): Promise<MailOauthRouteResult> => {
    const body = completeBodySchema.safeParse(ctx.body);
    if (!body.success) throw new ValidationError("The body must hold a non-empty 'state' and 'code'");
    const userId = ctx.identity.user.id;

    const consumed = await withTransaction(pool, (transaction) =>
      consumeMailOauthState(transaction, { state: body.data.state, userId }),
    );
    if (consumed === null) {
      throw new ValidationError("The sign-in state is unknown, expired or already used", { field: "state" });
    }
    const { provider } = consumed;
    // Read before the provider call: a deployment that cannot restart the lifecycle replaces no token.
    const reauthorization =
      consumed.mailboxItemId === null
        ? null
        : { mailboxItemId: consumed.mailboxItemId, liveSync: requireLiveSync(dependencies) };
    const { client, redirectUri } = requireOauthClient(dependencies, provider);
    const fetchImpl = dependencies.outboundHttp ?? fetch;

    let tokens: AuthorizationCodeTokens;
    try {
      tokens = await exchangeAuthorizationCode({
        tokenUrl: PROVIDER_SETTINGS[provider].tokenUrl,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        redirectUri,
        code: body.data.code,
        codeVerifier: consumed.codeVerifier,
        fetchImpl,
      });
    } catch (error) {
      if (error instanceof MailAdminConsentRequiredError) {
        throw new ChokePointError(
          400,
          "mail_admin_consent_required",
          "The account's organization requires administrator approval for this application",
        );
      }
      // `invalid_grant` is the token endpoint refusing what the caller presented: the code or its
      // verifier (RFC 6749 §5.2). Every other 400 or 401 (`invalid_client` for a wrong or expired client
      // secret, a malformed request, an answer naming no known code) is a fault of this deployment,
      // not of the caller's input, so it propagates: the adapter logs it and answers a generic 500.
      if (error instanceof MailAuthorizationCodeRejectedError && error.providerError === "invalid_grant") {
        throw new ValidationError("The provider rejected the authorization code", { field: "code" });
      }
      throw error;
    }
    const identity =
      provider === "gmail"
        ? await fetchGmailIdentity(fetchImpl, tokens.accessToken)
        : await fetchGraphIdentity(fetchImpl, tokens.accessToken);

    if (reauthorization !== null) {
      const { mailboxItemId, liveSync } = reauthorization;
      try {
        await withTransaction(pool, (transaction) =>
          replaceMailboxCredential(transaction, {
            mailboxItemId,
            provider,
            address: identity.address,
            refreshToken: tokens.refreshToken,
          }),
        );
      } catch (error) {
        // The mailbox records no address and another mailbox of the tenant records this one.
        if (error instanceof ProviderAccountAlreadyConnectedError) throw wrongAccountError();
        throw error;
      }
      await liveSync.restartAccount(mailboxItemId);
      return { status: 200, body: { mailboxId: mailboxItemId } };
    }

    let mailboxId: string;
    try {
      mailboxId = await withTransaction(pool, (transaction) =>
        createConnectedMailbox(transaction, { provider, identity, refreshToken: tokens.refreshToken, userId }),
      );
    } catch (error) {
      if (!(error instanceof ProviderAccountAlreadyConnectedError)) throw error;
      const existing = await withTransaction(pool, (transaction) =>
        findMailboxByProviderAccountAddress(transaction, identity.address),
      );
      throw new ChokePointError(error.status, error.code, error.message, { mailboxId: existing });
    }
    return { status: 201, body: { mailboxId } };
  };
}
