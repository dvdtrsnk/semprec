import { RECORDINGS_ROUTES } from "./routeMatrix/recordings.js";
import { MAIL_MAILBOXES_ROUTES } from "./routeMatrix/mailMailboxes.js";
import { AGENT_GUIDANCE_ROUTES } from "./routeMatrix/agentGuidance.js";
import { SEMP_ROUTES } from "./routeMatrix/semp.js";
import { SERVER_INFO_ROUTES } from "./routeMatrix/serverInfo.js";
import { HEALTHZ_ROUTES } from "./routeMatrix/healthz.js";
import { AUTH_ROUTES } from "./routeMatrix/auth.js";
import { PUSH_SUBSCRIPTIONS_ROUTES } from "./routeMatrix/pushSubscriptions.js";
import { NOTIFICATIONS_ROUTES } from "./routeMatrix/notifications.js";
import { NOTIFICATION_PREFERENCES_ROUTES } from "./routeMatrix/notificationPreferences.js";
import { HEARTBEATS_ROUTES } from "./routeMatrix/heartbeats.js";
import { SEMP_STATUS_ROUTES } from "./routeMatrix/sempStatus.js";
import { SCHEMA_ROUTES } from "./routeMatrix/schema.js";
import { AI_USAGE_ROUTES } from "./routeMatrix/aiUsage.js";
import { SYSTEM_HEALTH_ROUTES } from "./routeMatrix/systemHealth.js";
import { PROPOSALS_ROUTES } from "./routeMatrix/proposals.js";
import { TASKS_ROUTES } from "./routeMatrix/tasks.js";
import { JOURNAL_ROUTES } from "./routeMatrix/journal.js";
import { TRANSCRIPTIONS_ROUTES } from "./routeMatrix/transcriptions.js";
import { TRANSCRIPTS_ROUTES } from "./routeMatrix/transcripts.js";
import { INBOX_TYPES_ROUTES } from "./routeMatrix/inboxTypes.js";
import { APPROVAL_REQUESTS_ROUTES } from "./routeMatrix/approvalRequests.js";
import { MCP_ROUTES } from "./routeMatrix/mcp.js";
import { AGENT_RUNS_ROUTES } from "./routeMatrix/agentRuns.js";
import { MCP_GRANTS_ROUTES } from "./routeMatrix/mcpGrants.js";
import { MCP_TOOL_REGISTRATIONS_ROUTES } from "./routeMatrix/mcpToolRegistrations.js";
import { DATABASES_ROUTES } from "./routeMatrix/databases.js";
import { PROPERTIES_ROUTES } from "./routeMatrix/properties.js";
import { VIEWS_ROUTES } from "./routeMatrix/views.js";
import { ITEMS_ROUTES } from "./routeMatrix/items.js";
import { FILES_ROUTES } from "./routeMatrix/files.js";
import { BLOBS_ROUTES } from "./routeMatrix/blobs.js";
import { ACCOUNT_ROUTES } from "./routeMatrix/account.js";
import { ADMIN_ROUTES } from "./routeMatrix/admin.js";
import { VOICE_ROUTES } from "./routeMatrix/voice.js";
import { SYNC_ROUTES } from "./routeMatrix/sync.js";
import { MAIL_ROUTES } from "./routeMatrix/mail.js";
import { TRANSCRIPT_SUMMARIES_ROUTES } from "./routeMatrix/transcriptSummaries.js";
import { CALENDAR_ROUTES } from "./routeMatrix/calendar.js";
import { EVENTS_ROUTES } from "./routeMatrix/events.js";
import { AREAS_ROUTES } from "./routeMatrix/areas.js";
import { LIBRARY_ROUTES } from "./routeMatrix/library.js";
import { INBOX_CARDS_ROUTES } from "./routeMatrix/inboxCards.js";
import { SLEEP_ROUTES } from "./routeMatrix/sleep.js";
import { BADGE_COUNTS_ROUTES } from "./routeMatrix/badgeCounts.js";
import { OVERVIEW_ROUTES } from "./routeMatrix/overview.js";
import { DATABASE_GRANTS_ROUTES } from "./routeMatrix/databaseGrants.js";
import { SEARCH_ROUTES } from "./routeMatrix/search.js";
import { TRASH_ROUTES } from "./routeMatrix/trash.js";
import { PROJECT_HEARTBEATS_ROUTES } from "./routeMatrix/projectHeartbeats.js";
import { PROJECT_AGENT_SUMMARY_ROUTES } from "./routeMatrix/projectAgentSummary.js";
import { INBOX_ITEMS_ROUTES } from "./routeMatrix/inboxItems.js";
import { MCP_SERVERS_ROUTES } from "./routeMatrix/mcpServers.js";

/**
 * Every route (HTTP, WS or client-side view) and whether it is reachable without a session.
 * `__tests__/routeMatrix.test.ts` drives every `surface: "api"` entry against the real dispatcher,
 * so a `public: false` entry whose handler does not authenticate fails with a non-401.
 * `__tests__/routeMatrixCoverage.unit.test.ts` compares every custom and resource route definition
 * with these entries, so adding a route means adding (and justifying) an entry; prefix-routed paths
 * (`/mcp`, `/api/auth/`, `/api/files`, ...) are covered only by their own entries.
 *
 * `"view"` and `"ws"` entries are listed for the record and not fetch-tested: this service does not
 * serve the SPA, and a plain fetch without `Upgrade` never reaches `syncHandler.ts`'s
 * authentication (its handshake refusal is tested in `syncHandler`'s own tests).
 *
 * Entries live in the slice modules under `routeMatrix/`: a new one goes at the end of its path
 * family's slice, or in a new slice appended to `ROUTE_MATRIX`.
 *
 * `ModuleRegistry` is in-process only and opens no socket, so it has no entries.
 */
export interface RouteMatrixEntry {
  /** For docs/failure messages only; matching uses `method` + `path`. */
  name: string;
  method: string;
  /** Any `:id`-style segment is filled with a valid but nonexistent id. */
  path: string;
  /** Only `"api"` entries are fetch-tested; see the interface comment for `"view"` and `"ws"`. */
  surface: "api" | "view" | "ws";
  /** `false` means an unauthenticated request must get a 401. */
  public: boolean;
  /** Required when `public` is true. */
  publicReason?: string;
  /** A member gets 403 `admin_required`. */
  admin?: boolean;
  /**
   * Whose data the route reaches; `__tests__/tenantIsolationRoutes.test.ts` runs each `"api"` entry
   * through its class's two-tenant case:
   * - `anonymous`: reachable without a session (`public: true`).
   * - `admin`: an entry with `admin: true`.
   * - `account`: only the caller's own rows in global identity tables (logout, current session,
   * revoke session, push subscriptions).
   * - `tenant`: everything else, including `/mcp`, `/api/sync` and account export/deletion.
   */
  tenancy: RouteTenancy;
}

export const ROUTE_TENANCIES = ["tenant", "account", "admin", "anonymous"] as const;
export type RouteTenancy = (typeof ROUTE_TENANCIES)[number];

export const ROUTE_MATRIX: RouteMatrixEntry[] = [
  ...RECORDINGS_ROUTES,
  ...MAIL_MAILBOXES_ROUTES,
  ...AGENT_GUIDANCE_ROUTES,
  ...SEMP_ROUTES,
  ...SERVER_INFO_ROUTES,
  ...HEALTHZ_ROUTES,
  ...AUTH_ROUTES,
  ...PUSH_SUBSCRIPTIONS_ROUTES,
  ...NOTIFICATIONS_ROUTES,
  ...NOTIFICATION_PREFERENCES_ROUTES,
  ...HEARTBEATS_ROUTES,
  ...SEMP_STATUS_ROUTES,
  ...SCHEMA_ROUTES,
  ...AI_USAGE_ROUTES,
  ...SYSTEM_HEALTH_ROUTES,
  ...PROPOSALS_ROUTES,
  ...TASKS_ROUTES,
  ...JOURNAL_ROUTES,
  ...TRANSCRIPTIONS_ROUTES,
  ...TRANSCRIPTS_ROUTES,
  ...INBOX_TYPES_ROUTES,
  ...APPROVAL_REQUESTS_ROUTES,
  ...MCP_ROUTES,
  ...AGENT_RUNS_ROUTES,
  ...MCP_GRANTS_ROUTES,
  ...MCP_TOOL_REGISTRATIONS_ROUTES,
  ...DATABASES_ROUTES,
  ...PROPERTIES_ROUTES,
  ...VIEWS_ROUTES,
  ...ITEMS_ROUTES,
  ...FILES_ROUTES,
  ...BLOBS_ROUTES,
  ...ACCOUNT_ROUTES,
  ...ADMIN_ROUTES,
  ...VOICE_ROUTES,
  ...SYNC_ROUTES,
  ...MAIL_ROUTES,
  ...TRANSCRIPT_SUMMARIES_ROUTES,
  ...CALENDAR_ROUTES,
  ...EVENTS_ROUTES,
  ...AREAS_ROUTES,
  ...LIBRARY_ROUTES,
  ...INBOX_CARDS_ROUTES,
  ...SLEEP_ROUTES,
  ...BADGE_COUNTS_ROUTES,
  ...OVERVIEW_ROUTES,
  ...DATABASE_GRANTS_ROUTES,
  ...SEARCH_ROUTES,
  ...TRASH_ROUTES,
  ...PROJECT_HEARTBEATS_ROUTES,
  ...PROJECT_AGENT_SUMMARY_ROUTES,
  ...INBOX_ITEMS_ROUTES,
  ...MCP_SERVERS_ROUTES,
];
