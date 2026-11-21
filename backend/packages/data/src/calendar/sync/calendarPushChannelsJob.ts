// Keeps an account's push channels in line with what it syncs: a Google channel per tracked calendar of a `gmail_api`
// account, one Graph subscription per `graph_api` account, while Calendars is on, the grant covers calendars, the
// last pass ended `ok` and this process hosts the provider's webhook. Channels within a day of their expiry are
// replaced (Google) or extended (Graph); every other channel is stopped at the provider and its row deleted.
import type { Pool } from "pg";
import { z } from "zod";
import { getItemById } from "../../chokePoint/itemsStore.js";
import { withTransaction } from "../../db/pool.js";
import { refreshAndPersistAccessToken } from "../../mail/mailOAuthAccess.js";
import { getMailAccountGrant } from "../../mail/mailAccountSyncStateStore.js";
import { areCalendarsEnabled } from "../../mail/mailboxServiceHooks.js";
import { GOOGLE_TOKEN_URL, MICROSOFT_TOKEN_URL } from "../../mail/oauthTokenExchange.js";
import { hasCalendarConsent } from "../../mail/oauthServiceScopes.js";
import { forEachActiveTenant } from "../../tenancy/forEachActiveTenant.js";
import { logger } from "../logger.js";
import { GoogleCalendarHttp, type GoogleAccessTokenSource } from "./adapters/google/googleCalendarHttp.js";
import { GraphCalendarHttp } from "./adapters/graph/graphCalendarHttp.js";
import { enqueueCalendarPushChannels } from "./calendarPushChannelsEnqueue.js";
import {
  deleteCalendarPushChannel,
  insertCalendarPushChannel,
  listCalendarPushAccounts,
  listCalendarPushChannelsOfAccount,
  recordCalendarPushChannelExpiry,
  type CalendarPushChannel,
  type CalendarPushProvider,
} from "./calendarPushChannelsStore.js";
import {
  getCalendarAccountSyncState,
  listSyncedAccountCalendars,
  resolveCalendarSyncIds,
} from "./calendarSyncStore.js";
import { stopGoogleChannel, watchGoogleCalendar } from "./googleChannels.js";
import {
  createGraphCalendarSubscription,
  deleteGraphCalendarSubscription,
  renewGraphCalendarSubscription,
} from "./graphCalendarSubscriptions.js";

/** A channel this close to its expiry is replaced or extended. */
export const CALENDAR_PUSH_RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;
/** The deadline of every provider call of one account's maintenance together. */
const MAINTENANCE_TIMEOUT_MS = 2 * 60_000;
const ACCESS_TOKEN_EXPIRY_MARGIN_MS = 60_000;
/** The `credential_access_log` purpose of the token refreshes. */
const CALENDAR_PUSH_PURPOSE = "calendar_push";

const PROVIDER_OF_SYNC_MODE: Readonly<Record<string, CalendarPushProvider>> = {
  gmail_api: "google",
  graph_api: "graph",
};
const SYNC_MODE_OF_PROVIDER: Readonly<Record<CalendarPushProvider, string>> = {
  google: "gmail_api",
  graph: "graph_api",
};
const TOKEN_URL_OF_PROVIDER: Readonly<Record<CalendarPushProvider, string>> = {
  google: GOOGLE_TOKEN_URL,
  graph: MICROSOFT_TOKEN_URL,
};

export interface CalendarPushProviderRuntime {
  clientId: string;
  clientSecret: string;
  /** The public HTTPS webhook; `null` when this deployment does not host it, so no channel is kept. */
  notificationUrl: string | null;
}

/** What the maintenance needs from the process that runs it: the pool and each provider's OAuth client. */
export interface CalendarPushRuntime {
  pool: Pool;
  google: CalendarPushProviderRuntime | null;
  graph: CalendarPushProviderRuntime | null;
  fetchImpl?: typeof fetch;
}

let runtime: CalendarPushRuntime | null = null;

/** Set by the process that runs the queue before it starts, and cleared (`null`) when it stops. */
export function setCalendarPushRuntime(next: CalendarPushRuntime | null): void {
  runtime = next;
}

/** One step's outcome, counted in the result. */
type StepKind = "created" | "renewed" | "stopped";

export interface CalendarPushMaintenanceResult {
  created: number;
  renewed: number;
  stopped: number;
  failed: number;
}

/** Thrown after every step ran, when at least one failed, so the queue retries the account. */
export class CalendarPushMaintenanceError extends Error {
  constructor(readonly result: CalendarPushMaintenanceResult) {
    super(`Calendar push maintenance failed ${result.failed} step(s)`);
    this.name = "CalendarPushMaintenanceError";
  }
}

interface WantedCalendar {
  calendarItemId: string;
  remoteId: string;
}

interface Plan {
  provider: CalendarPushProvider | null;
  /** Google: the tracked calendars of the account. */
  calendars: WantedCalendar[];
  channels: CalendarPushChannel[];
}

const payloadSchema = z.strictObject({ accountItemId: z.uuid() });

function hostedProvider(current: CalendarPushRuntime | null, provider: CalendarPushProvider): boolean {
  return (current?.[provider]?.notificationUrl ?? null) !== null;
}

async function readPlan(pool: Pool, accountItemId: string, current: CalendarPushRuntime | null): Promise<Plan> {
  return withTransaction(pool, async (client) => {
    const channels = await listCalendarPushChannelsOfAccount(client, accountItemId);
    const none: Plan = { provider: null, calendars: [], channels };
    const ids = await resolveCalendarSyncIds(client);
    if (ids === null) return none;
    const account = await getItemById(client, ids.mailboxesDatabaseId, accountItemId);
    if (!account || account.deletedAt || !areCalendarsEnabled(account.properties)) return none;
    const grant = await getMailAccountGrant(client, accountItemId);
    const provider = grant === null ? undefined : PROVIDER_OF_SYNC_MODE[grant.syncMode];
    if (grant === null || provider === undefined || !hostedProvider(current, provider)) return none;
    if (!hasCalendarConsent(grant)) return none;
    if ((await getCalendarAccountSyncState(client, accountItemId))?.status !== "ok") return none;
    const tracked = await listSyncedAccountCalendars(client, ids, accountItemId);
    return {
      provider,
      calendars: tracked.map((calendar) => ({ calendarItemId: calendar.calendarItemId, remoteId: calendar.remoteId })),
      channels,
    };
  });
}

/** Newest expiry first. */
function newestFirst(channels: CalendarPushChannel[]): CalendarPushChannel[] {
  return [...channels].sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime());
}

function expiresSoon(channel: CalendarPushChannel, now: number): boolean {
  return channel.expiresAt.getTime() - now <= CALENDAR_PUSH_RENEW_BEFORE_MS;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Builds each provider's HTTP client once, on first use, over a token refreshed through the stored credential. */
class ProviderClients {
  private google: GoogleCalendarHttp | null = null;
  private graph: GraphCalendarHttp | null = null;

  constructor(
    private readonly current: CalendarPushRuntime,
    private readonly accountItemId: string,
  ) {}

  private tokenSource(provider: CalendarPushProvider, client: CalendarPushProviderRuntime): GoogleAccessTokenSource {
    let kept: { accessToken: string; expiresAt: Date } | null = null;
    return {
      get: async () => {
        if (kept !== null && Date.now() < kept.expiresAt.getTime() - ACCESS_TOKEN_EXPIRY_MARGIN_MS) {
          return kept.accessToken;
        }
        kept = await refreshAndPersistAccessToken(this.current.pool, {
          mailboxItemId: this.accountItemId,
          tokenUrl: TOKEN_URL_OF_PROVIDER[provider],
          clientId: client.clientId,
          clientSecret: client.clientSecret,
          purpose: CALENDAR_PUSH_PURPOSE,
          ...(this.current.fetchImpl ? { fetchImpl: this.current.fetchImpl } : {}),
        });
        return kept.accessToken;
      },
      invalidate: () => {
        kept = null;
      },
    };
  }

  googleHttp(): GoogleCalendarHttp {
    const client = this.current.google;
    if (client === null) throw new Error("No Google OAuth client is configured for calendar push channels");
    this.google ??= new GoogleCalendarHttp(this.tokenSource("google", client), this.current.fetchImpl ?? fetch);
    return this.google;
  }

  graphHttp(): GraphCalendarHttp {
    const client = this.current.graph;
    if (client === null) throw new Error("No Microsoft OAuth client is configured for calendar push channels");
    if (this.graph === null) {
      const tokens = this.tokenSource("graph", client);
      this.graph = new GraphCalendarHttp(() => tokens.get(), this.current.fetchImpl ?? fetch);
    }
    return this.graph;
  }
}

/**
 * One account's maintenance, run as the `calendarPushChannels` task (key `calendar-push-channels:<account>`), queued
 * by the hourly sweep and when the account's Calendars are switched off or the account is removed (whose removal has
 * already taken the rows). Each step runs on its own: a provider call, then its row written in its own transaction.
 * A channel whose stop fails is still forgotten, since the provider ends it at its expiry and the webhook answers its
 * notifications as unknown. Without a runtime the account's rows are only forgotten.
 */
export async function handleCalendarPushChannelsTask(
  pool: Pool,
  payload: unknown,
  options: { runtime?: CalendarPushRuntime | null } = {},
): Promise<CalendarPushMaintenanceResult> {
  const { accountItemId } = payloadSchema.parse(payload);
  const current = options.runtime === undefined ? runtime : options.runtime;
  const plan = await readPlan(pool, accountItemId, current);
  const result: CalendarPushMaintenanceResult = { created: 0, renewed: 0, stopped: 0, failed: 0 };
  const signal = AbortSignal.timeout(MAINTENANCE_TIMEOUT_MS);
  const clients = current === null ? null : new ProviderClients(current, accountItemId);

  async function step(kind: StepKind, channel: { provider: CalendarPushProvider }, run: () => Promise<void>) {
    try {
      await run();
      result[kind] += 1;
    } catch (error) {
      result.failed += 1;
      // Provider errors can carry request details: ids, the step and the error's name only.
      logger.warn(
        { accountItemId, provider: channel.provider, step: kind, errorName: errorName(error) },
        "Calendar push channel step failed",
      );
    }
  }

  async function stopAtProvider(channel: CalendarPushChannel): Promise<void> {
    if (clients === null || current === null || current[channel.provider] === null) return;
    if (channel.provider === "graph") {
      await deleteGraphCalendarSubscription(clients.graphHttp(), channel.channelId, signal);
    } else if (channel.resourceId !== null) {
      const { channelId, resourceId } = channel;
      await stopGoogleChannel(clients.googleHttp(), { channelId, resourceId }, signal);
    }
  }

  async function stop(channel: CalendarPushChannel): Promise<void> {
    await step("stopped", channel, async () => {
      let refused: { error: unknown } | null = null;
      try {
        await stopAtProvider(channel);
      } catch (error) {
        refused = { error };
      }
      // Forgotten either way: the provider ends a channel it still has at its expiry.
      await withTransaction(pool, (client) => deleteCalendarPushChannel(client, channel.provider, channel.channelId));
      if (refused !== null) throw refused.error;
    });
  }

  async function createGoogle(calendar: WantedCalendar, notificationUrl: string): Promise<boolean> {
    let created = false;
    await step("created", { provider: "google" }, async () => {
      if (clients === null) throw new Error("No runtime for calendar push channels");
      const channel = await watchGoogleCalendar(clients.googleHttp(), calendar.remoteId, notificationUrl, signal);
      await withTransaction(pool, (client) =>
        insertCalendarPushChannel(client, {
          provider: "google",
          channelId: channel.channelId,
          accountItemId,
          calendarItemId: calendar.calendarItemId,
          resourceId: channel.resourceId,
          secret: channel.token,
          expiresAt: channel.expiresAt,
        }),
      );
      created = true;
    });
    return created;
  }

  async function createGraph(notificationUrl: string): Promise<void> {
    await step("created", { provider: "graph" }, async () => {
      if (clients === null) throw new Error("No runtime for calendar push channels");
      const subscription = await createGraphCalendarSubscription(clients.graphHttp(), notificationUrl, signal);
      await withTransaction(pool, (client) =>
        insertCalendarPushChannel(client, {
          provider: "graph",
          channelId: subscription.subscriptionId,
          accountItemId,
          calendarItemId: null,
          resourceId: null,
          secret: subscription.clientState,
          expiresAt: subscription.expiresAt,
        }),
      );
    });
  }

  const now = Date.now();
  /** Channels kept, or already dealt with; every other one is stopped. */
  const settled = new Set<CalendarPushChannel>();
  const notificationUrl = plan.provider === null ? null : (current?.[plan.provider]?.notificationUrl ?? null);

  if (plan.provider === "google" && notificationUrl !== null) {
    for (const calendar of plan.calendars) {
      const [newest] = newestFirst(
        plan.channels.filter(
          (channel) => channel.provider === "google" && channel.calendarItemId === calendar.calendarItemId,
        ),
      );
      if (newest !== undefined && !expiresSoon(newest, now)) {
        settled.add(newest);
        continue;
      }
      // The expiring channel keeps notifying until its replacement exists; a failed replacement keeps it.
      if (!(await createGoogle(calendar, notificationUrl)) && newest !== undefined) settled.add(newest);
    }
  }

  if (plan.provider === "graph" && notificationUrl !== null) {
    const [newest] = newestFirst(plan.channels.filter((channel) => channel.provider === "graph"));
    if (newest === undefined) {
      await createGraph(notificationUrl);
    } else if (!expiresSoon(newest, now)) {
      settled.add(newest);
    } else {
      let gone = false;
      try {
        if (clients === null) throw new Error("No runtime for calendar push channels");
        const expiresAt = await renewGraphCalendarSubscription(clients.graphHttp(), newest.channelId, signal);
        if (expiresAt === null) {
          gone = true;
        } else {
          // A row deleted meanwhile (the account was switched off) is not recreated; its maintenance stops it.
          const recorded = await withTransaction(pool, (client) =>
            recordCalendarPushChannelExpiry(client, "graph", newest.channelId, expiresAt),
          );
          if (recorded) result.renewed += 1;
        }
      } catch (error) {
        result.failed += 1;
        logger.warn(
          { accountItemId, provider: "graph", step: "renewed", errorName: errorName(error) },
          "Calendar push channel step failed",
        );
      }
      settled.add(newest);
      if (gone) {
        await withTransaction(pool, (client) => deleteCalendarPushChannel(client, "graph", newest.channelId));
        await createGraph(notificationUrl);
      }
    }
  }

  for (const channel of plan.channels) {
    if (!settled.has(channel)) await stop(channel);
  }

  logger.info({ accountItemId, ...result }, "Calendar push channels maintained");
  if (result.failed > 0) throw new CalendarPushMaintenanceError(result);
  return result;
}

/** Queues the maintenance of every account that has a channel or could have one, each tenant in its own scope. */
export async function handleCalendarPushChannelsSweepTask(pool: Pool): Promise<void> {
  const current = runtime;
  const syncModes = (["google", "graph"] as const)
    .filter((provider) => hostedProvider(current, provider))
    .map((provider) => SYNC_MODE_OF_PROVIDER[provider]);
  await forEachActiveTenant(pool, async () => {
    const accounts = await withTransaction(pool, (client) => listCalendarPushAccounts(client, syncModes));
    for (const accountItemId of accounts) await enqueueCalendarPushChannels(pool, accountItemId);
  });
}
