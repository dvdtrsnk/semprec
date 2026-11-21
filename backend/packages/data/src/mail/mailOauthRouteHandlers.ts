import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { enqueueCalendarAccountSync } from "../calendar/sync/calendarAccountSyncEnqueue.js";
import { clearCalendarSyncCredentialRefusal } from "../calendar/sync/calendarSyncStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemById, lockItemById } from "../chokePoint/itemsStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { areCalendarsEnabled, NEW_MAILBOX_SERVICE_SWITCHES } from "./mailboxServiceHooks.js";
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
  recordGrantedOauthScopes,
  recordProviderAccountAddress,
  type MailAccountSyncStateRow,
} from "./mailAccountSyncStateStore.js";
import { writeMailboxAddresses } from "./mailboxAddresses.js";
import { resolveMailModuleIds } from "./mailModuleIds.js";
import {
  consumeMailOauthState,
  createMailOauthState,
  MAIL_OAUTH_PROVIDERS,
  MAIL_OAUTH_REDIRECT_TARGETS,
  type CreatedMailOauthState,
  type MailOauthProvider,
} from "./mailOauthStatesStore.js";
import { MAIL_ACCOUNT_SERVICES, oauthScopesForServices, type MailAccountService } from "./oauthServiceScopes.js";
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
import type { CustomRouteResult, RouteParams, RouteBody, RouteUser } from "../customRoute.js";
import { ensureComposeFolders, type ProviderFolder } from "./folderDiscovery.js";
import { GMAIL_SYSTEM_FOLDERS } from "./gmailReconcile.js";
import { graphProviderFolder } from "./graphReconcile.js";
import { logger } from "./logger.js";

/**
 * Served without a session. The redirect URI is this path on the configured redirect base URL, identical in the
 * authorization request and the code exchange.
 */
const MAIL_OAUTH_CALLBACK_PATH = "/api/mail/oauth/callback";

interface MailOauthProviderSettings {
  /** The provider's product name; the user can rename the mailbox afterwards. */
  mailboxName: string;
  authorizeUrl: string;
  tokenUrl: string;
  authorizeParams: Readonly<Record<string, string>>;
}

const PROVIDER_SETTINGS: Record<MailOauthProvider, MailOauthProviderSettings> = {
  gmail: {
    mailboxName: "Gmail",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: GOOGLE_TOKEN_URL,
    // `offline` asks for a refresh token; `consent` makes Google return one again on a repeated sign-in.
    authorizeParams: { access_type: "offline", prompt: "consent" },
  },
  outlook: {
    mailboxName: "Outlook",
    // `/common` accepts work or school accounts and personal Microsoft accounts.
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: MICROSOFT_TOKEN_URL,
    authorizeParams: {},
  },
};

interface MailOauthClient {
  clientId: string;
  clientSecret: string;
}

/** The custom-route container members these routes read; `CustomRouteDependencies` is assignable to it. */
export interface MailOauthRouteDependencies {
  oauth?: {
    gmail?: MailOauthClient;
    msGraph?: MailOauthClient;
    redirectBaseUrl?: string;
  };
  outboundHttp?: typeof fetch;
  /** Called by a reauthorization after its commit. */
  mailLiveSync?: { restartAccount(mailboxItemId: string): Promise<void> };
}

/** Missing deployment configuration fails with a plain error, which the adapter answers with a generic 500. */
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
  services: readonly MailAccountService[],
  created: CreatedMailOauthState,
): string {
  const settings = PROVIDER_SETTINGS[provider];
  const url = new URL(settings.authorizeUrl);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: oauthScopesForServices(provider, services).join(" "),
    state: created.state,
    code_challenge: created.codeChallenge,
    code_challenge_method: "S256",
    ...settings.authorizeParams,
  }).toString();
  return url.toString();
}

const servicesSchema = z.array(z.enum(MAIL_ACCOUNT_SERVICES)).min(1).max(MAIL_ACCOUNT_SERVICES.length);
const redirectTargetSchema = z.enum(MAIL_OAUTH_REDIRECT_TARGETS);

/** The first field a refused body names; a missing, unknown or misshapen `provider` and an unknown key name `fallback`. */
function refusedField(error: z.ZodError, fields: readonly string[], fallback: string): string {
  const field = error.issues[0]?.path[0];
  return typeof field === "string" && fields.includes(field) ? field : fallback;
}

/** In `MAIL_ACCOUNT_SERVICES` order, without repeats. */
function serviceSet(services: Iterable<MailAccountService>): MailAccountService[] {
  const wanted = new Set(services);
  return MAIL_ACCOUNT_SERVICES.filter((service) => wanted.has(service));
}

const SERVICES_MESSAGE = "'services' must be a non-empty list of 'mail' and 'calendars'";
const REDIRECT_TARGET_MESSAGE = "'redirectTarget' must be 'app'";

const startBodySchema = z
  .object({
    provider: z.enum(MAIL_OAUTH_PROVIDERS),
    services: servicesSchema.optional(),
    redirectTarget: redirectTargetSchema.optional(),
  })
  .strict();

/**
 * `POST /api/mail/mailboxes/oauth/start`. The PKCE verifier stays sealed in the state row. `services` (default
 * `["mail"]`) must include `mail`: a new account is connected through its mail identity and starts with Mail on.
 */
export function createMailOauthStartRouteHandler(pool: Pool, dependencies: MailOauthRouteDependencies) {
  return async (ctx: RouteBody & RouteUser): Promise<CustomRouteResult> => {
    const body = startBodySchema.safeParse(ctx.body);
    if (!body.success) {
      const field = refusedField(body.error, ["services", "redirectTarget"], "provider");
      throw new ValidationError(
        field === "provider"
          ? "'provider' must be 'gmail' or 'outlook'"
          : field === "services"
            ? SERVICES_MESSAGE
            : REDIRECT_TARGET_MESSAGE,
        { field },
      );
    }
    const { provider } = body.data;
    const services = serviceSet(body.data.services ?? ["mail"]);
    if (!services.includes("mail")) {
      throw new ValidationError("'services' must include 'mail' for a new account", { field: "services" });
    }
    const { client, redirectUri } = requireOauthClient(dependencies, provider);
    const created = await withTransaction(pool, (transaction) =>
      createMailOauthState(transaction, {
        userId: ctx.identity.user.id,
        provider,
        mailboxItemId: null,
        services,
        redirectTarget: body.data.redirectTarget ?? null,
      }),
    );
    return {
      status: 200,
      body: { authorizeUrl: buildAuthorizeUrl(provider, client.clientId, redirectUri, services, created) },
    };
  };
}

function isMailOauthProvider(value: unknown): value is MailOauthProvider {
  return typeof value === "string" && (MAIL_OAUTH_PROVIDERS as readonly string[]).includes(value);
}

/**
 * `null` for an unknown, soft-deleted or foreign mailbox (RLS hides it) or a tenant without a Mailboxes database, all
 * alike. With `lock` the row is locked for the caller's transaction.
 */
async function liveMailbox(client: PoolClient, mailboxItemId: string, lock: boolean): Promise<ItemRow | null> {
  const mailboxesDatabase = await getDatabaseByModuleId(client, MAILBOXES_MODULE_ID);
  if (mailboxesDatabase === null) return null;
  const mailbox = await (lock ? lockItemById : getItemById)(client, mailboxesDatabase.id, mailboxItemId);
  return mailbox === null || mailbox.deletedAt !== null ? null : mailbox;
}

/**
 * `provider` must be `gmail` or `outlook` and the sync state's `sync_mode`, which decides where the stored credential
 * is sent, must be that provider's API. The user-owned label alone does not decide: replacing a relabelled IMAP
 * mailbox's password with a refresh token would break it and send the token to a server it was not issued for.
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

/** A malformed id names no mailbox, so it gets the same 404 as an unknown one. */
const mailboxIdSchema = z.uuid();

const reauthorizeBodySchema = z
  .object({ services: servicesSchema.optional(), redirectTarget: redirectTargetSchema.optional() })
  .strict();

/**
 * `POST /api/mail/mailboxes/:id/reauthorize`: answers an authorization URL for a one-time state carrying the mailbox
 * id. It asks for the services switched on for the mailbox together with the body's `services`, the mail scopes
 * always among them. The sync state row is read unlocked, so this refusal is only an early answer; the completion
 * decides again under the row lock. Locking it here, after the Mailboxes item, would invert the lock order of the
 * completion and sync job.
 */
export function createMailboxReauthorizeRouteHandler(pool: Pool, dependencies: MailOauthRouteDependencies) {
  return async (ctx: RouteParams & RouteBody & RouteUser): Promise<CustomRouteResult> => {
    const mailboxId = mailboxIdSchema.safeParse(ctx.params.id);
    if (!mailboxId.success) throw new NotFoundError("Mailbox not found");
    const body = reauthorizeBodySchema.safeParse(ctx.body);
    if (!body.success) {
      const field = refusedField(body.error, ["services", "redirectTarget"], "body");
      throw new ValidationError(
        field === "services"
          ? SERVICES_MESSAGE
          : field === "redirectTarget"
            ? REDIRECT_TARGET_MESSAGE
            : "The body may hold only 'services' and 'redirectTarget'",
        { field },
      );
    }
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
      // Mail is always asked for (see `oauthScopesForServices`), whether it is switched on or not.
      const services = serviceSet([
        "mail",
        ...(areCalendarsEnabled(mailbox.properties) ? (["calendars"] as const) : []),
        ...(body.data.services ?? []),
      ]);
      const created = await createMailOauthState(transaction, {
        userId: ctx.identity.user.id,
        provider,
        mailboxItemId: mailboxId.data,
        services,
        redirectTarget: body.data.redirectTarget ?? null,
      });
      return buildAuthorizeUrl(provider, client.clientId, redirectUri, services, created);
    });
    return { status: 200, body: { authorizeUrl } };
  };
}

const PROVIDER_TIMEOUT_MS = 15_000;
/** A Gmail send-as list carries every alias's HTML signature, so the cap is well above a token response's. */
const PROVIDER_RESPONSE_LIMIT_BYTES = 1024 * 1024;
/** Bounds what one response can put on the mailbox. */
const MAX_ALIASES = 100;

const GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const GMAIL_SEND_AS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs";
/** Graph returns `proxyAddresses` only when `$select` names it. */
const GRAPH_ME_URL = "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,proxyAddresses";
/** The Graph well-known names of the folders a new message needs. */
const GRAPH_COMPOSE_FOLDERS = ["drafts", "sentitems"] as const;

function graphWellKnownFolderUrl(wellKnownName: (typeof GRAPH_COMPOSE_FOLDERS)[number]): string {
  return `https://graph.microsoft.com/v1.0/me/mailFolders/${wellKnownName}?$select=id,displayName`;
}
/** `SMTP:` on the primary address, `smtp:` on a secondary one. */
const SMTP_PROXY_ADDRESS_PREFIX = /^smtp:/i;

const ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+$/;

function isAddress(value: unknown): value is string {
  return typeof value === "string" && ADDRESS_PATTERN.test(value.trim());
}

/**
 * Aborted after `PROVIDER_TIMEOUT_MS` and on every way out; the body is capped. No thrown message holds the access
 * token or the response body.
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
  address: string;
  aliases: string[];
}

/** An alias counts only when Gmail marks it primary or verified: anybody can add a pending address. */
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
 * `mail` is the mailbox address, else `userPrincipalName`; SMTP entries of `proxyAddresses` are the aliases. Personal
 * accounts have no such list, so a missing list means no aliases.
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

/**
 * The account's Drafts and Sent folders as the first sync pass writes them. A folder whose read fails is left to that
 * pass: the account is already signed in, and only a draft or send before the pass is refused meanwhile.
 */
async function fetchGraphComposeFolders(fetchImpl: typeof fetch, accessToken: string): Promise<ProviderFolder[]> {
  const folders: ProviderFolder[] = [];
  for (const wellKnownName of GRAPH_COMPOSE_FOLDERS) {
    try {
      const folder = await getProviderJson(
        fetchImpl,
        graphWellKnownFolderUrl(wellKnownName),
        accessToken,
        "Microsoft Graph folder",
      );
      if (typeof folder.id !== "string" || folder.id === "" || typeof folder.displayName !== "string") {
        throw new Error("Microsoft Graph folder response holds no id and display name");
      }
      folders.push(graphProviderFolder({ id: folder.id, displayName: folder.displayName, wellKnownName }));
    } catch (error) {
      logger.warn(
        { wellKnownName, errorName: error instanceof Error ? error.name : typeof error },
        "The connect could not read a Microsoft Graph folder; the first sync pass discovers it",
      );
    }
  }
  return folders;
}

interface NewMailbox {
  provider: MailOauthProvider;
  identity: ProviderIdentity;
  /** The account's folders found at connect. */
  folders: readonly ProviderFolder[];
  refreshToken: string;
  grantedScopes: readonly string[];
  services: readonly MailAccountService[];
  userId: string;
}

/**
 * When `recordProviderAccountAddress` refuses a duplicate address, Postgres has already aborted the transaction, so the
 * caller rolls it back.
 */
async function createConnectedMailbox(client: PoolClient, mailbox: NewMailbox): Promise<string> {
  const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
  const item = await createItemWithClient(
    client,
    {
      databaseId: mailboxesDatabaseId,
      properties: {
        name: PROVIDER_SETTINGS[mailbox.provider].mailboxName,
        provider: mailbox.provider,
        ...NEW_MAILBOX_SERVICE_SWITCHES,
        calendarsEnabled: mailbox.services.includes("calendars"),
      },
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
  await recordGrantedOauthScopes(client, item.id, mailbox.grantedScopes);
  await recordProviderAccountAddress(client, item.id, mailbox.identity.address);
  if (mailbox.provider === "gmail") {
    await recordGmailWatchEmailAddress(client, item.id, mailbox.identity.address);
  }
  await ensureComposeFolders(client, item.id, mailbox.folders);
  await enqueueMailAccountSync(client, item.id);
  return item.id;
}

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
  address: string;
  refreshToken: string;
  grantedScopes: readonly string[];
}

/**
 * Replaces an existing mailbox's refresh token and its recorded granted scopes, clears a calendar sync status that
 * waits for a new sign-in and queues its mail sync and, with Calendars on, its calendar sync, checking
 * `reauthorizationProvider` and the signed-in address under this transaction's locks. The sync state row is locked
 * before the Mailboxes item, the order the sync job takes them; an unseeded mailbox gets its sync state row here,
 * before either lock.
 */
async function replaceMailboxCredential(client: PoolClient, reauthorization: Reauthorization): Promise<void> {
  const { mailboxItemId, provider } = reauthorization;
  const staleState = (): ValidationError =>
    new ValidationError("The sign-in state names no mailbox of its provider any more", { field: "state" });

  // Unlocked and no guard: it keeps the next statement from running for a foreign id, whose sync state insert would
  // collide with a row RLS hides and fail unexpectedly.
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
  await recordGrantedOauthScopes(client, mailboxItemId, reauthorization.grantedScopes);
  await clearCalendarSyncCredentialRefusal(client, mailboxItemId);
  await enqueueMailAccountSync(client, mailboxItemId);
  if (areCalendarsEnabled(mailbox.properties)) await enqueueCalendarAccountSync(client, mailboxItemId);
}

/** Missing deployment configuration fails with a plain error, which the adapter answers with a generic 500. */
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
 * `POST /api/mail/mailboxes/oauth/complete`. No transaction is open across the provider call:
 * 1. Consume the state and commit (default isolation: a race loser must read "no row", not a serialization failure).
 *    The state stays consumed whatever follows.
 * 2. Outside any transaction, exchange the code and fetch the account's addresses. `invalid_grant` is a 400; anything
 *    else but required admin consent propagates as a generic 500.
 * 3. A new Outlook account's Drafts and Sent folders are read, still outside any transaction (Gmail's are fixed).
 * 4. Write the mailbox with the granted scopes and those folders; a duplicate provider address is decided by the unique
 *    index and answered 409 with the other mailbox's id. For a reauthorization state, `replaceMailboxCredential` runs
 *    instead of 3 and 4, and after the commit the live-sync root restarts the hosted lifecycle so it reads the new
 *    token.
 * No token, code or verifier is logged or returned.
 */
export function createMailOauthCompleteRouteHandler(pool: Pool, dependencies: MailOauthRouteDependencies) {
  return async (ctx: RouteBody & RouteUser): Promise<CustomRouteResult> => {
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
      // `invalid_grant` refuses the caller's code or verifier (RFC 6749 §5.2). It is a flag, not read from
      // `providerError`, which is blanked when the code contains the provider's error token. Every other 400/401 is a
      // fault of this deployment and propagates as a generic 500.
      if (error instanceof MailAuthorizationCodeRejectedError && error.grantRefused) {
        throw new ValidationError("The provider rejected the authorization code", { field: "code" });
      }
      throw error;
    }
    // A token response without `scope` granted exactly what was asked for (RFC 6749 §5.1).
    const grantedScopes = tokens.grantedScopes ?? oauthScopesForServices(provider, consumed.services);
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
            grantedScopes,
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

    const folders =
      provider === "gmail" ? GMAIL_SYSTEM_FOLDERS : await fetchGraphComposeFolders(fetchImpl, tokens.accessToken);
    let mailboxId: string;
    try {
      mailboxId = await withTransaction(pool, (transaction) =>
        createConnectedMailbox(transaction, {
          provider,
          identity,
          folders,
          refreshToken: tokens.refreshToken,
          grantedScopes,
          services: consumed.services,
          userId,
        }),
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
