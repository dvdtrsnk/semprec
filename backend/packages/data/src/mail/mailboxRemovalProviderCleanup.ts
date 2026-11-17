// Cleanup of a removed mailbox outside the database: what the removal transaction reads for it, kept in
// memory only, and the best-effort steps that run after the commit.
import { DatabaseError, type PoolClient } from "pg";
import { currentTenantScope } from "@semprec/shared";
import { getCredentialType, getDecryptedCredential } from "../credentials/externalCredentialsStore.js";
import { logger } from "./logger.js";
import { getGmailAccountUse, type MailAccountSyncStateRow } from "./mailAccountSyncStateStore.js";
import { GOOGLE_TOKEN_URL, MICROSOFT_TOKEN_URL, refreshAccessToken } from "./oauthTokenExchange.js";

const GMAIL_WATCH_STOP_URL = "https://gmail.googleapis.com/gmail/v1/users/me/stop";
const GOOGLE_TOKEN_REVOCATION_URL = "https://oauth2.googleapis.com/revoke";
const GRAPH_SUBSCRIPTIONS_URL = "https://graph.microsoft.com/v1.0/subscriptions";

const DEFAULT_STEP_TIMEOUT_MS = 10_000;

interface RemovedGmailGrant {
  provider: "gmail";
  /** `null` when the stored credential could not be decrypted. */
  refreshToken: string | null;
  watchRegistered: boolean;
}

/**
 * Why no Google call is made: another mailbox (any tenant) records the same account, or no account is
 * recorded so sharing cannot be ruled out.
 */
type MailboxRemovalCleanupSkip = "accountShared" | "accountUnknown";

/**
 * `users.stop` and token revocation act on the whole Google account, for every mailbox connected to it
 * in any tenant, so they are made only for the sole mailbox recording the account. A retained grant's
 * refresh token is not read.
 */
interface RetainedGmailGrant {
  provider: "gmailRetained";
  reason: MailboxRemovalCleanupSkip;
  watchRegistered: boolean;
}

interface RemovedGraphSubscription {
  provider: "outlook";
  /** Only buys the access token of the delete call. */
  refreshToken: string | null;
  subscriptionId: string;
}

/** Read before the removal deletes the rows; lives in memory only and is written nowhere. */
export interface MailboxRemovalCleanupInput {
  mailboxItemId: string;
  provider: RemovedGmailGrant | RetainedGmailGrant | RemovedGraphSubscription | null;
}

/**
 * An undecryptable credential answers `null` and does not fail the removal. A failed statement is
 * rethrown: it has aborted the removal's transaction.
 */
async function readRefreshToken(
  client: PoolClient,
  mailboxItemId: string,
  actingUserId: string | undefined,
): Promise<string | null> {
  try {
    return await getDecryptedCredential(client, {
      itemId: mailboxItemId,
      actorType: "user",
      actorId: actingUserId,
      purpose: "mailbox_removal",
    });
  } catch (error) {
    if (error instanceof DatabaseError) throw error;
    return null;
  }
}

/**
 * Runs inside the removal transaction, before its deletes.
 *
 * The provider is decided by the sync mode, not the user-editable `provider` property, so a token is
 * only ever sent to the provider it was already sent to (an Outlook mailbox relabelled `gmail` never
 * reaches Google).
 *
 * A `gmail_api` mailbox is cleaned up at Google only when it is the sole mailbox recording its account;
 * otherwise it answers a retained grant whose steps are skipped. The credential is decrypted only when
 * a provider step needs it (sole Gmail grant, or Graph with a recorded subscription).
 */
export async function readMailboxRemovalCleanupInput(
  client: PoolClient,
  input: { mailboxItemId: string; syncState: MailAccountSyncStateRow | null; actingUserId?: string },
): Promise<MailboxRemovalCleanupInput> {
  const { mailboxItemId, syncState } = input;
  const syncMode = syncState?.syncMode ?? null;
  const subscriptionId = syncMode === "graph_api" ? (syncState?.graphSubscriptionId ?? null) : null;
  if (syncMode !== "gmail_api" && subscriptionId === null) return { mailboxItemId, provider: null };
  if ((await getCredentialType(client, mailboxItemId)) !== "oauth2_refresh_token") {
    return { mailboxItemId, provider: null };
  }
  if (subscriptionId !== null) {
    const refreshToken = await readRefreshToken(client, mailboxItemId, input.actingUserId);
    return { mailboxItemId, provider: { provider: "outlook", refreshToken, subscriptionId } };
  }
  const watchRegistered = (syncState?.gmailWatchExpiresAt ?? null) !== null;
  const accountUse = await getGmailAccountUse(client, mailboxItemId);
  if (accountUse !== "sole") {
    const reason = accountUse === "shared" ? "accountShared" : "accountUnknown";
    return { mailboxItemId, provider: { provider: "gmailRetained", reason, watchRegistered } };
  }
  const refreshToken = await readRefreshToken(client, mailboxItemId, input.actingUserId);
  return { mailboxItemId, provider: { provider: "gmail", refreshToken, watchRegistered } };
}

interface OauthClient {
  clientId: string;
  clientSecret: string;
}

/** A missing member fails the step that needs it with `notConfigured`; `outboundHttp` falls back to `fetch`. */
export interface MailboxRemovalCleanupDependencies {
  oauth?: { gmail?: OauthClient; msGraph?: OauthClient };
  mailLiveSync?: { stopMailbox(tenantId: string, mailboxItemId: string): Promise<void> };
  outboundHttp?: typeof fetch;
}

type MailboxRemovalCleanupStep = "liveSyncStop" | "gmailWatchStop" | "graphSubscriptionDelete" | "tokenRevocation";

/**
 * The only thing a failure log says about a step. `providerRejected` excludes the 404 that counts as a
 * deleted Graph subscription. The token exchange before a call is classified the same way.
 */
type MailboxRemovalCleanupFailure =
  "notConfigured" | "credentialUnavailable" | "timeout" | "providerRejected" | "failed";

type StepOutcome = MailboxRemovalCleanupFailure | null;

/**
 * The log line never carries the caught error: a provider or network error can hold the request, and
 * the request holds the token. A step that throws is reported as `failed`.
 */
async function runStep(
  mailboxItemId: string,
  step: MailboxRemovalCleanupStep,
  run: () => Promise<StepOutcome>,
): Promise<void> {
  let classification: StepOutcome;
  try {
    classification = await run();
  } catch {
    classification = "failed";
  }
  if (classification !== null) {
    logger.warn({ mailboxItemId, step, classification }, "Mailbox removal cleanup step failed");
  }
}

/** Logs nothing of the mailbox that shares the account. */
function logSkippedStep(
  mailboxItemId: string,
  step: MailboxRemovalCleanupStep,
  classification: MailboxRemovalCleanupSkip,
): void {
  logger.info({ mailboxItemId, step, classification }, "Mailbox removal cleanup step skipped");
}

/**
 * Uses the tenant of the active scope (`removeMailbox` runs in the mailbox's tenant). On `timeout` the
 * cleanup moves on; the stop itself is not cancelled.
 */
async function stopLiveSync(
  mailboxItemId: string,
  dependencies: MailboxRemovalCleanupDependencies,
  timeoutMs: number,
): Promise<StepOutcome> {
  const control = dependencies.mailLiveSync;
  if (!control) return "notConfigured";
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant") return "failed";
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    return await Promise.race([control.stopMailbox(scope.tenantId, mailboxItemId).then(() => null), limit]);
  } finally {
    clearTimeout(timer);
  }
}

type ProviderAnswer = { status: number } | { failure: "timeout" | "failed" };

/** The body is not read and the request is ended on every path, so no connection stays open. */
async function callProvider(
  dependencies: MailboxRemovalCleanupDependencies,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<ProviderAnswer> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await (dependencies.outboundHttp ?? fetch)(url, { ...init, signal: controller.signal });
    return { status: response.status };
  } catch {
    return { failure: timedOut ? "timeout" : "failed" };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function outcomeOf(answer: ProviderAnswer, alsoDone: readonly number[] = []): StepOutcome {
  if ("failure" in answer) return answer.failure;
  const done = (answer.status >= 200 && answer.status < 300) || alsoDone.includes(answer.status);
  return done ? null : "providerRejected";
}

/**
 * Persists nothing: a rotated refresh token is dropped, because the credential no longer exists.
 * `refreshAccessToken` hides what the provider did, so its request goes through a recording `fetch` and
 * a failed exchange is classified from that record; an aborted signal can only be the exchange's own
 * time limit.
 */
async function accessTokenOf(
  grant: RemovedGmailGrant | RemovedGraphSubscription,
  dependencies: MailboxRemovalCleanupDependencies,
): Promise<{ accessToken: string } | { failure: MailboxRemovalCleanupFailure }> {
  const client = grant.provider === "gmail" ? dependencies.oauth?.gmail : dependencies.oauth?.msGraph;
  if (!client) return { failure: "notConfigured" };
  if (grant.refreshToken === null) return { failure: "credentialUnavailable" };
  const outbound = dependencies.outboundHttp ?? fetch;
  const request: { answer: ProviderAnswer | null } = { answer: null };
  const recordingFetch: typeof fetch = async (url, init) => {
    try {
      const response = await outbound(url, init);
      request.answer = { status: response.status };
      return response;
    } catch (error) {
      request.answer = { failure: init?.signal?.aborted === true ? "timeout" : "failed" };
      throw error;
    }
  };
  try {
    const refreshed = await refreshAccessToken({
      tokenUrl: grant.provider === "gmail" ? GOOGLE_TOKEN_URL : MICROSOFT_TOKEN_URL,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      refreshToken: grant.refreshToken,
      fetchImpl: recordingFetch,
    });
    return { accessToken: refreshed.accessToken };
  } catch {
    // A 2xx answer here is one the exchange could not read or use, so it is no refusal.
    return { failure: (request.answer === null ? null : outcomeOf(request.answer)) ?? "failed" };
  }
}

/** Ends the push notifications of the whole account; takes no watch id. */
async function stopGmailWatch(
  grant: RemovedGmailGrant,
  dependencies: MailboxRemovalCleanupDependencies,
  timeoutMs: number,
): Promise<StepOutcome> {
  const token = await accessTokenOf(grant, dependencies);
  if ("failure" in token) return token.failure;
  const answer = await callProvider(
    dependencies,
    GMAIL_WATCH_STOP_URL,
    { method: "POST", headers: { Authorization: `Bearer ${token.accessToken}` } },
    timeoutMs,
  );
  return outcomeOf(answer);
}

/** A 404 counts as done: the subscription expired or was removed out of band. */
async function deleteGraphSubscription(
  subscription: RemovedGraphSubscription,
  dependencies: MailboxRemovalCleanupDependencies,
  timeoutMs: number,
): Promise<StepOutcome> {
  const token = await accessTokenOf(subscription, dependencies);
  if ("failure" in token) return token.failure;
  const answer = await callProvider(
    dependencies,
    `${GRAPH_SUBSCRIPTIONS_URL}/${encodeURIComponent(subscription.subscriptionId)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token.accessToken}` } },
    timeoutMs,
  );
  return outcomeOf(answer, [404]);
}

/** The token travels in the request body, not in the URL. */
async function revokeGoogleToken(
  grant: RemovedGmailGrant,
  dependencies: MailboxRemovalCleanupDependencies,
  timeoutMs: number,
): Promise<StepOutcome> {
  if (grant.refreshToken === null) return "credentialUnavailable";
  const answer = await callProvider(
    dependencies,
    GOOGLE_TOKEN_REVOCATION_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: grant.refreshToken }),
    },
    timeoutMs,
  );
  return outcomeOf(answer);
}

/**
 * Never rejects, so no step can fail a removal that already happened. Every step runs whether or not an
 * earlier one failed:
 *
 * 1. `liveSyncStop` first, so the hosted lifecycle registers or renews nothing after the steps below.
 * 2. `gmailWatchStop` or `graphSubscriptionDelete`.
 * 3. `tokenRevocation` (Gmail only) after step 2, which needs an access token of the grant it ends.
 *    Microsoft offers no per-application refresh token revocation.
 *
 * For a retained Google grant steps 2 and 3 are logged as skipped.
 */
export async function cleanUpRemovedMailbox(
  input: MailboxRemovalCleanupInput,
  dependencies: MailboxRemovalCleanupDependencies,
  stepTimeoutMs: number = DEFAULT_STEP_TIMEOUT_MS,
): Promise<void> {
  const { mailboxItemId, provider } = input;
  await runStep(mailboxItemId, "liveSyncStop", () => stopLiveSync(mailboxItemId, dependencies, stepTimeoutMs));
  if (provider === null) return;
  if (provider.provider === "outlook") {
    await runStep(mailboxItemId, "graphSubscriptionDelete", () =>
      deleteGraphSubscription(provider, dependencies, stepTimeoutMs),
    );
    return;
  }
  if (provider.provider === "gmailRetained") {
    if (provider.watchRegistered) logSkippedStep(mailboxItemId, "gmailWatchStop", provider.reason);
    logSkippedStep(mailboxItemId, "tokenRevocation", provider.reason);
    return;
  }
  if (provider.watchRegistered) {
    await runStep(mailboxItemId, "gmailWatchStop", () => stopGmailWatch(provider, dependencies, stepTimeoutMs));
  }
  await runStep(mailboxItemId, "tokenRevocation", () => revokeGoogleToken(provider, dependencies, stepTimeoutMs));
}
