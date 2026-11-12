// The cleanup of a removed mailbox outside Semprec's database (issue gh-2030): what the removal
// transaction reads for it, and the best-effort steps that run after the commit.
// Constrained by: docs/adr/2026-11-11-a-removed-mailbox-is-cleaned-up-at-the-provider-from-memory-after-the-commit.md
import { DatabaseError, type PoolClient } from "pg";
import { currentTenantScope } from "@semprec/shared";
import { getCredentialType, getDecryptedCredential } from "../credentials/externalCredentialsStore.js";
import { logger } from "./logger.js";
import { getGmailAccountUse, type MailAccountSyncStateRow } from "./mailAccountSyncStateStore.js";
import { GOOGLE_TOKEN_URL, MICROSOFT_TOKEN_URL, refreshAccessToken } from "./oauthTokenExchange.js";

const GMAIL_WATCH_STOP_URL = "https://gmail.googleapis.com/gmail/v1/users/me/stop";
const GOOGLE_TOKEN_REVOCATION_URL = "https://oauth2.googleapis.com/revoke";
const GRAPH_SUBSCRIPTIONS_URL = "https://graph.microsoft.com/v1.0/subscriptions";

/** The time limit of one cleanup step, unless the caller passes its own. */
const DEFAULT_STEP_TIMEOUT_MS = 10_000;

/**
 * The Google grant of a removed mailbox that synced through the Gmail API and was the only mailbox
 * recording its Google account: its watch, when one is recorded, is stopped and its token is revoked.
 */
interface RemovedGmailGrant {
  provider: "gmail";
  /** The mailbox's OAuth refresh token, or `null` when the stored credential could not be decrypted. */
  refreshToken: string | null;
  /** Whether `mail_account_sync_state` records a `users.watch` registration of the mailbox. */
  watchRegistered: boolean;
}

/**
 * Why the cleanup makes no call at Google for a removed `gmail_api` mailbox, the only thing a skip
 * log says about it:
 * - `accountShared`: another mailbox, of this or of another tenant, records the same Google account;
 * - `accountUnknown`: the mailbox's sync state row records no Google account, so the cleanup cannot
 *   tell whether another mailbox depends on it.
 */
type MailboxRemovalCleanupSkip = "accountShared" | "accountUnknown";

/**
 * The Google grant of a removed `gmail_api` mailbox that the cleanup leaves in place. Stopping the
 * watch and revoking the token act on the whole Google account: `users.stop` ends the account's push
 * notifications and the revocation ends its grant to the deployment, for every mailbox connected to
 * that account, in any tenant. Both are therefore made only for a mailbox known to be the only one
 * that records the account. The refresh token of a retained grant is not read.
 */
interface RetainedGmailGrant {
  provider: "gmailRetained";
  reason: MailboxRemovalCleanupSkip;
  /** As in `RemovedGmailGrant`; it decides whether the watch stop is one of the skipped steps. */
  watchRegistered: boolean;
}

/** The Microsoft Graph subscription of a removed mailbox that synced through Graph, which is deleted. */
interface RemovedGraphSubscription {
  provider: "outlook";
  /** As in `RemovedGmailGrant`; here it only buys the access token of the delete call. */
  refreshToken: string | null;
  subscriptionId: string;
}

/**
 * What the removal transaction read for the cleanup before it deleted the rows. It lives in memory
 * from that read to the end of `cleanUpRemovedMailbox` and is written nowhere.
 */
export interface MailboxRemovalCleanupInput {
  mailboxItemId: string;
  /**
   * The work at the provider, a Google grant the cleanup leaves in place, or `null` when the mailbox
   * has neither (see `readMailboxRemovalCleanupInput`).
   */
  provider: RemovedGmailGrant | RetainedGmailGrant | RemovedGraphSubscription | null;
}

/**
 * The refresh token of an OAuth mailbox, decrypted as the removing user. A credential that cannot be
 * opened answers `null` and does not fail the removal, which deletes that credential next; the
 * cleanup then reports the steps that needed the token. A failed statement is rethrown: it has
 * aborted the removal's transaction, like a failure of any other statement of the removal.
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
 * Reads what the cleanup of mailbox `mailboxItemId` needs, inside the removal transaction and before
 * its deletes. `syncState` is the mailbox's locked `mail_account_sync_state` row, or `null` when it
 * has none.
 *
 * The provider is the one the row's sync mode names: `gmail_api` is Google, `graph_api` is
 * Microsoft. The mailbox's `provider` property does not decide. The user owns it and a generic item
 * write changes it, while the sync mode is what the sync job and the hosted lifecycles dispatch on,
 * so it names the provider the stored credential is already sent to. The token of an Outlook mailbox
 * relabelled `gmail` is therefore not sent to Google.
 *
 * A `gmail_api` mailbox that holds an OAuth refresh token is cleaned up at Google only when it is the
 * only mailbox that records its Google account (`getGmailAccountUse`, read here, before the removal
 * deletes the row that records it). Otherwise it answers a retained grant, whose steps the cleanup
 * skips: the calls at Google act on the whole account, and another mailbox, possibly of another
 * tenant, would lose its grant and its push notifications.
 *
 * The credential is decrypted only when a step at the provider needs it: for such a sole `gmail_api`
 * mailbox (its token is revoked), and for a `graph_api` mailbox that holds an OAuth refresh token and
 * has a Graph subscription recorded (the subscription is deleted). The credential of a retained
 * grant is not read. Every other mailbox answers `provider: null` and its credential is not read
 * either: a mailbox without a sync state row, an `imap` mailbox, a `graph_api` mailbox without a
 * recorded subscription, and a mailbox whose credential is not an OAuth refresh token.
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

/**
 * The members of the composition root's custom-route container the cleanup calls
 * (docs/adr/2026-10-29-custom-route-composition-root-dependencies.md). `semprec-api`'s
 * `CustomRouteDependencies` is assignable to it. A member that is left out fails the step that
 * needs it with `notConfigured`; `outboundHttp` falls back to the global `fetch`.
 */
export interface MailboxRemovalCleanupDependencies {
  oauth?: { gmail?: OauthClient; msGraph?: OauthClient };
  mailLiveSync?: { stopMailbox(tenantId: string, mailboxItemId: string): Promise<void> };
  /** Replaces the global `fetch` for the calls to the provider. */
  outboundHttp?: typeof fetch;
}

/** The steps of the cleanup, as a failure log names them. */
type MailboxRemovalCleanupStep = "liveSyncStop" | "gmailWatchStop" | "graphSubscriptionDelete" | "tokenRevocation";

/**
 * Why a step did not do its work, the only thing a failure log says about it:
 * - `notConfigured`: the composition root did not supply what the step calls;
 * - `credentialUnavailable`: the removal could not decrypt the mailbox's refresh token;
 * - `timeout`: the live-sync control, or the provider in one of the step's requests, did not answer
 *   within the time limit;
 * - `providerRejected`: the provider answered one of the step's requests with a status outside 2xx,
 *   other than the 404 that counts as a deleted Graph subscription;
 * - `failed`: anything else, such as a network error, a live-sync control that rejected, or an answer
 *   to the token exchange that could not be read or holds no access token.
 *
 * A step's requests are its call to the provider and, for the two steps that need an access token,
 * the token exchange before it (`accessTokenOf`). Both are classified the same way.
 */
type MailboxRemovalCleanupFailure =
  "notConfigured" | "credentialUnavailable" | "timeout" | "providerRejected" | "failed";

/** `null` when the step did its work. */
type StepOutcome = MailboxRemovalCleanupFailure | null;

/**
 * Runs one step and logs its failure. The log line carries the mailbox id, the step and the fixed
 * classification, never the caught error: a provider or network error can hold the request, and the
 * request holds the token. A step that throws is reported as `failed`.
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

/**
 * Logs a step the cleanup does not make for a retained Google grant. The line carries the mailbox id,
 * the step and the fixed classification, and nothing of the mailbox that shares the account.
 */
function logSkippedStep(
  mailboxItemId: string,
  step: MailboxRemovalCleanupStep,
  classification: MailboxRemovalCleanupSkip,
): void {
  logger.info({ mailboxItemId, step, classification }, "Mailbox removal cleanup step skipped");
}

/**
 * Stops the mailbox's hosted lifecycle through the live-sync control, for the tenant of the scope
 * this call runs in: `removeMailbox` runs in the tenant the mailbox belongs to and calls the cleanup
 * from that scope. Outside a tenant scope there is no tenant to name, and the step is reported as
 * `failed`. When the control does not answer within `timeoutMs` the step is reported as `timeout`
 * and the cleanup moves on; the stop itself is not cancelled.
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

/** What one request to a provider came to: the status of its answer, or why there is none. */
type ProviderAnswer = { status: number } | { failure: "timeout" | "failed" };

/**
 * One request to a provider under `timeoutMs`. Answers the response status, or why there is none.
 * The response body is not read, and the request is ended on every path, so no connection stays
 * open behind an unread body.
 */
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

/** A step's outcome from the provider's answer: any 2xx status, and each status of `alsoDone`, is the work done. */
function outcomeOf(answer: ProviderAnswer, alsoDone: readonly number[] = []): StepOutcome {
  if ("failure" in answer) return answer.failure;
  const done = (answer.status >= 200 && answer.status < 300) || alsoDone.includes(answer.status);
  return done ? null : "providerRejected";
}

/**
 * An access token of the removed mailbox's grant, for the one call that needs it. The exchange is
 * `refreshAccessToken`, which has its own time limit and persists nothing: a refresh token the
 * provider rotates in its answer is dropped, because the mailbox's credential no longer exists.
 *
 * `refreshAccessToken` rejects without saying what the provider did, apart from a 400 or 401. Its
 * one request therefore goes through a `fetch` that records what the request came to, and a failed
 * exchange is classified from that record like a direct call (`outcomeOf`): `timeout` when the
 * request ended unanswered with its signal aborted, which only the exchange's own time limit does;
 * `providerRejected` when the provider answered with a status outside 2xx; `failed` for everything
 * else, an exchange that failed before or after its request included. The caught error is not read.
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

/** Gmail's `users.stop`: ends the push notifications of the account the grant belongs to. It takes no watch id. */
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

/**
 * Deletes the mailbox's Graph subscription. A 404 is the work done as well: Graph no longer has the
 * subscription, because it expired or was removed out of band.
 */
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

/** Google's token revocation. The token travels in the request body, not in the URL. */
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
 * The cleanup of a removed mailbox, run by `removeMailbox` after its transaction committed. A step
 * that fails does not make it reject, so no step can fail a removal that already happened. Its steps
 * run in this order, and each one runs whether or not an earlier one failed:
 *
 * 1. `liveSyncStop`, for every mailbox: the hosted live-sync lifecycle is stopped, so that it
 *    registers or renews nothing after the steps below.
 * 2. `gmailWatchStop`, for a `gmail_api` mailbox with a recorded watch, or `graphSubscriptionDelete`,
 *    for a `graph_api` mailbox with a recorded subscription.
 * 3. `tokenRevocation`, for a `gmail_api` mailbox: after step 2, which needs an access token of the
 *    grant this step ends. Microsoft offers no call that revokes one application's refresh token, so
 *    a `graph_api` mailbox has no such step.
 *
 * For a retained Google grant (`RetainedGmailGrant`) steps 2 and 3 make no call: each is logged as
 * skipped with the fixed reason (`logSkippedStep`), and the answer of the removal does not differ.
 *
 * A step that fails is logged with its fixed classification (`runStep`). `stepTimeoutMs` bounds the
 * live-sync stop and each call to a provider; the token exchange of step 2 has its own limit, and
 * running into it is the step's `timeout` as well.
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
