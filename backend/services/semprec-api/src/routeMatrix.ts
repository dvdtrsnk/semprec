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

/**
 * The single documented artifact issue #143 asks for: every route delivered through auth-v1,
 * HTTP or client-side view, and whether it is reachable without a session.
 * `__tests__/routeMatrix.test.ts` drives every `surface: "api"` entry end to end against the
 * real dispatcher (`app.ts`'s `createDispatcher`) — an entry with `public: false` that a handler
 * doesn't actually gate behind `authenticateRequest` fails that test with a non-401 response,
 * and a newly added route that's never added here simply isn't covered, so adding a route always
 * means adding (and justifying) an entry. `surface: "view"` entries have no backend of their own
 * to fetch-test — this service doesn't serve the SPA — so they're listed for the record only;
 * the "documents a reason for every public entry" test still covers them.
 *
 * The entries live in the slice modules under `routeMatrix/`, which `ROUTE_MATRIX` below
 * concatenates: a new entry goes at the end of the slice of its path family, or in a new slice
 * appended to the concatenation when no slice fits.
 *
 * `surface: "ws"` (issue #160's `WS /api/sync`) is listed for the same documentation purpose as
 * `"view"`, but isn't fetch-tested here either — a plain HTTP fetch with no `Upgrade` header never
 * reaches `syncHandler.ts`'s authentication at all, it just falls through this dispatcher's normal
 * 404. Its "invalid credential never completes the handshake" behavior is covered instead by a
 * real WS-upgrade test in `syncHandler`'s own test file.
 *
 * Non-HTTP surfaces inventoried for issue #143 and found not to apply, so they have no entries
 * below:
 * - Module routes: `ModuleRegistry` (`backend/packages/module-registry`) is in-process only —
 *   `loadModule()` does a plain dynamic `import()` of caller-supplied file paths, and every
 *   other method returns typed data to other backend code. It never opens a socket.
 * - Other view paths: the web client (`web/`) has no router and no login page yet — every page
 *   is a query-param-selected React component with no per-view auth guard. The only view path
 *   auth-v1 actually delivered is the setup wizard in `routeMatrix/auth.ts` (issue #234). Gating the client's other
 *   views is a follow-up for whichever issue adds a login page; this service's routes are what
 *   auth-v1 #143 can enforce today, and every read/write those views depend on is in the table.
 * - Health-style probes: `GET /healthz` (issue #168) is the one probe this service serves; see
 *   its entry in `routeMatrix/healthz.ts`.
 */
export interface RouteMatrixEntry {
  /** For docs/failure messages only — matching is driven by `method` + `path` below. */
  name: string;
  method: string;
  /** A concrete, requestable path — any `:id`-style segment is filled with a syntactically valid but nonexistent id. */
  path: string;
  /**
   * `"api"` entries are fetch-tested against this service's real dispatcher. `"view"` entries
   * are client-side-only paths this backend doesn't serve, kept here for the documented
   * exceptions list but not fetch-tested — there's no server for `routeMatrix.test.ts` to hit.
   * `"ws"` is the one WS-upgrade route (issue #160); see this file's top comment for why it isn't
   * fetch-tested here either.
   */
  surface: "api" | "view" | "ws";
  /** `false` (the default expectation) means an unauthenticated request must get a 401. */
  public: boolean;
  /** Required when `public` is true — why this route is one of the documented exceptions. */
  publicReason?: string;
  /** `true` for a route only an `admin` may call: a member gets 403 `admin_required`. */
  admin?: boolean;
  /**
   * Whose data the route reaches (issue #1053); `__tests__/tenantIsolationRoutes.test.ts` runs
   * each `surface: "api"` entry through its class's two-tenant case:
   * - `anonymous` — reachable without a session (`public: true`).
   * - `admin` — an entry with `admin: true` (#1037).
   * - `account` — reads or writes only the caller's own rows in global identity tables (logout,
   *   current session, revoke session, register/revoke push subscription).
   * - `tenant` — everything else, including `/mcp`, `/api/sync` and the account export/deletion
   *   routes.
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
];
