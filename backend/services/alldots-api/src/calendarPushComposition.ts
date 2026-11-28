import type { Pool } from "pg";
import type { CalendarPushProviderRuntime, CalendarPushRuntime } from "@alldots/data";
import { GOOGLE_CALENDAR_WEBHOOK_PATH, GRAPH_CALENDAR_WEBHOOK_PATH } from "./calendarWebhookHandlers.js";
import { logger } from "./logger.js";
import { publicHttpsOrigin } from "./mailLiveSyncLifecycles.js";
import type { OAuthClient } from "./mailSyncAdapters.js";

/** Google's `events.watch` also needs the webhook's domain verified for the project, which only the operator knows. */
export const GOOGLE_CALENDAR_WEBHOOK_ENABLED_ENV = "GOOGLE_CALENDAR_WEBHOOK_ENABLED";

/**
 * The calendar push runtime of the API queue: each provider with its OAuth client configured gets an entry, so its
 * existing channels can be stopped; it gets a `notificationUrl`, so channels are kept, only when `APP_BASE_URL` is a
 * public `https://` origin without a path, and for Google also when `GOOGLE_CALENDAR_WEBHOOK_ENABLED=true`. `null`
 * without either OAuth client.
 */
export function resolveCalendarPushRuntime(
  pool: Pool,
  env: NodeJS.ProcessEnv,
  clients: { gmail: OAuthClient | { missingEnv: string[] }; graph: OAuthClient | { missingEnv: string[] } },
): CalendarPushRuntime | null {
  const origin = publicHttpsOrigin(env.APP_BASE_URL ?? "");
  function provider(
    client: OAuthClient | { missingEnv: string[] },
    path: string,
    enabled: boolean,
  ): CalendarPushProviderRuntime | null {
    if ("missingEnv" in client) return null;
    return { ...client, notificationUrl: origin !== null && enabled ? `${origin}${path}` : null };
  }
  const google = provider(
    clients.gmail,
    GOOGLE_CALENDAR_WEBHOOK_PATH,
    env[GOOGLE_CALENDAR_WEBHOOK_ENABLED_ENV] === "true",
  );
  const graph = provider(clients.graph, GRAPH_CALENDAR_WEBHOOK_PATH, true);
  if (google === null && graph === null) return null;
  logger.info(
    {
      googleHosted: (google?.notificationUrl ?? null) !== null,
      graphHosted: (graph?.notificationUrl ?? null) !== null,
    },
    "Calendar push channels configured",
  );
  return { pool, google, graph };
}
