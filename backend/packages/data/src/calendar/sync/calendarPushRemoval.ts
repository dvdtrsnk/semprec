// The push channels of a removed account: the removal transaction deletes their rows and reads the refresh token
// before the credential goes, and after the commit each channel is stopped at its provider, best effort.
import { DatabaseError, type PoolClient } from "pg";
import { getDecryptedCredential } from "../../credentials/externalCredentialsStore.js";
import { GOOGLE_TOKEN_URL, MICROSOFT_TOKEN_URL, refreshAccessToken } from "../../mail/oauthTokenExchange.js";
import { logger } from "../logger.js";
import { GoogleCalendarHttp } from "./adapters/google/googleCalendarHttp.js";
import { GraphCalendarHttp } from "./adapters/graph/graphCalendarHttp.js";
import { takeCalendarPushChannelsOfAccount, type CalendarPushChannel } from "./calendarPushChannelsStore.js";
import { stopGoogleChannel } from "./googleChannels.js";
import { deleteGraphCalendarSubscription } from "./graphCalendarSubscriptions.js";

const DEFAULT_TIMEOUT_MS = 30_000;

/** Lives in memory only and is written nowhere. */
export interface RemovedCalendarPushChannels {
  accountItemId: string;
  channels: CalendarPushChannel[];
  /** `null` when no credential is stored or it could not be decrypted. */
  refreshToken: string | null;
}

/**
 * Runs inside the removal transaction, before the credential is deleted. `null` when the account has no channel; the
 * credential is decrypted only when it has. An undecryptable credential does not fail the removal; a failed statement
 * is rethrown, since it aborted the transaction.
 */
export async function takeRemovedAccountCalendarPush(
  client: PoolClient,
  accountItemId: string,
  actingUserId: string | undefined,
): Promise<RemovedCalendarPushChannels | null> {
  const channels = await takeCalendarPushChannelsOfAccount(client, accountItemId);
  if (channels.length === 0) return null;
  let refreshToken: string | null;
  try {
    refreshToken = await getDecryptedCredential(client, {
      itemId: accountItemId,
      actorType: "user",
      actorId: actingUserId,
      purpose: "calendar_push_removal",
    });
  } catch (error) {
    if (error instanceof DatabaseError) throw error;
    refreshToken = null;
  }
  return { accountItemId, channels, refreshToken };
}

interface OauthClient {
  clientId: string;
  clientSecret: string;
}

/** The same shape as the mailbox removal's cleanup dependencies. */
export interface CalendarPushRemovalDependencies {
  oauth?: { gmail?: OauthClient; msGraph?: OauthClient };
  outboundHttp?: typeof fetch;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Never rejects: the removal already happened. Each provider's token is refreshed once without being stored (the
 * credential no longer exists), then each channel is stopped. Run before the Google grant is revoked, which would
 * refuse the refresh. Failures are logged with ids, the provider and the error's name.
 */
export async function stopRemovedAccountCalendarPush(
  removed: RemovedCalendarPushChannels | null,
  dependencies: CalendarPushRemovalDependencies,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  if (removed === null) return;
  const outbound = dependencies.outboundHttp ?? fetch;
  const signal = AbortSignal.timeout(timeoutMs);
  for (const provider of ["google", "graph"] as const) {
    const channels = removed.channels.filter((channel) => channel.provider === provider);
    if (channels.length === 0) continue;
    try {
      const client = provider === "google" ? dependencies.oauth?.gmail : dependencies.oauth?.msGraph;
      if (client === undefined) throw new Error("No OAuth client is configured for the provider");
      if (removed.refreshToken === null) throw new Error("The account's refresh token is unavailable");
      const refreshToken = removed.refreshToken;
      // One refresh per provider: a refused one fails every stop of that provider alike.
      let token: Promise<string> | null = null;
      const accessToken = () =>
        (token ??= refreshAccessToken({
          tokenUrl: provider === "google" ? GOOGLE_TOKEN_URL : MICROSOFT_TOKEN_URL,
          clientId: client.clientId,
          clientSecret: client.clientSecret,
          refreshToken,
          fetchImpl: outbound,
        }).then((refreshed) => refreshed.accessToken));
      for (const channel of channels) {
        try {
          if (provider === "graph") {
            await deleteGraphCalendarSubscription(
              new GraphCalendarHttp(accessToken, outbound),
              channel.channelId,
              signal,
            );
          } else if (channel.resourceId !== null) {
            const http = new GoogleCalendarHttp({ get: accessToken, invalidate: () => {} }, outbound);
            await stopGoogleChannel(http, { channelId: channel.channelId, resourceId: channel.resourceId }, signal);
          }
        } catch (error) {
          logger.warn(
            { accountItemId: removed.accountItemId, provider, errorName: errorName(error) },
            "A removed account's calendar push channel could not be stopped",
          );
        }
      }
    } catch (error) {
      logger.warn(
        { accountItemId: removed.accountItemId, provider, errorName: errorName(error) },
        "A removed account's calendar push channels could not be stopped",
      );
    }
  }
}
