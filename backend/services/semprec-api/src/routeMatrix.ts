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
 *   auth-v1 actually delivered is the setup wizard below (issue #234). Gating the client's other
 *   views is a follow-up for whichever issue adds a login page; this service's routes are what
 *   auth-v1 #143 can enforce today, and every read/write those views depend on is in the table.
 * - Health-style probes: `GET /healthz` (issue #168) is the one probe this service serves; see
 *   its entry below.
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

const EXAMPLE_ID = "00000000-0000-0000-0000-000000000000";

export const ROUTE_MATRIX: RouteMatrixEntry[] = [
  {
    name: "shallow health check",
    method: "GET",
    path: "/healthz",
    surface: "api",
    public: true,
    tenancy: "anonymous",
    publicReason:
      "Issue #168: a deployment/orchestrator probe run with no session — its only content is a status word, never account or deployment detail.",
  },
  {
    name: "login",
    method: "POST",
    path: "/api/auth/login",
    surface: "api",
    public: true,
    tenancy: "anonymous",
    publicReason: "Issue #140: logging in is necessarily unauthenticated — it's how a session is obtained.",
  },
  {
    name: "password-reset request",
    method: "POST",
    path: "/api/auth/password-reset/request",
    surface: "api",
    public: true,
    tenancy: "anonymous",
    publicReason:
      "Issue #142: a forgotten password means there's no session yet; the response never reveals whether the email exists.",
  },
  {
    name: "password-reset consume",
    method: "POST",
    path: "/api/auth/password-reset/consume",
    surface: "api",
    public: true,
    tenancy: "anonymous",
    publicReason: "Issue #142: the single-use reset token itself is the credential presented here, not a session.",
  },
  {
    name: "first-account setup (API)",
    method: "POST",
    path: "/api/setup",
    surface: "api",
    public: true,
    tenancy: "anonymous",
    publicReason:
      "Issue #233: there is no user yet to authenticate as. Gated instead by SETUP_TOKEN and a hard 404 once any user exists.",
  },
  {
    name: "first-account setup wizard (view)",
    method: "GET",
    path: "/?page=setup&token=<setupToken>",
    surface: "view",
    public: true,
    tenancy: "anonymous",
    publicReason:
      "Issue #234: the wizard that calls the setup API above must itself be reachable before any account exists, for the same reason the API is public.",
  },
  { name: "logout", method: "POST", path: "/api/auth/logout", surface: "api", public: false, tenancy: "account" },
  {
    name: "revoke session",
    method: "POST",
    path: `/api/auth/sessions/${EXAMPLE_ID}/revoke`,
    surface: "api",
    public: false,
    tenancy: "account",
  },
  {
    name: "current session",
    method: "GET",
    path: "/api/auth/session",
    surface: "api",
    public: false,
    tenancy: "account",
  },
  {
    name: "register push subscription",
    method: "POST",
    path: "/api/push-subscriptions",
    surface: "api",
    public: false,
    tenancy: "account",
  },
  {
    name: "revoke push subscription",
    method: "POST",
    path: `/api/push-subscriptions/${EXAMPLE_ID}/revoke`,
    surface: "api",
    public: false,
    tenancy: "account",
  },
  {
    name: "unread notifications",
    method: "GET",
    path: "/api/notifications/unread",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "visit notification",
    method: "POST",
    path: `/api/notifications/${EXAMPLE_ID}/visit`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "mark all notifications read",
    method: "POST",
    path: "/api/notifications/mark-all-read",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "schema projection",
    method: "GET",
    path: "/api/schema",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "ai usage report",
    method: "GET",
    path: "/api/ai-usage?from=2026-01-01&to=2026-01-02",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "system health report",
    method: "GET",
    path: "/api/system-health",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "confirm proposal",
    method: "POST",
    path: `/api/proposals/${EXAMPLE_ID}/confirm`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "create transcription",
    method: "POST",
    path: "/api/transcriptions",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "transcription rerun",
    method: "POST",
    path: `/api/transcriptions/${EXAMPLE_ID}/rerun`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "transcript speakers",
    method: "GET",
    path: `/api/transcripts/${EXAMPLE_ID}/speakers`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "inbox types",
    method: "GET",
    path: "/api/inbox-types",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "approval queue",
    method: "GET",
    path: "/api/approval-requests",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "approval decision",
    method: "PATCH",
    path: `/api/approval-requests/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  { name: "mcp json-rpc endpoint", method: "POST", path: "/mcp", surface: "api", public: false, tenancy: "tenant" },
  {
    name: "agent run detail",
    method: "GET",
    path: `/api/agent-runs/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "mint mcp run credential",
    method: "POST",
    path: "/api/agent-runs/mcp-credentials",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "project mcp grants",
    method: "GET",
    path: `/api/projects/${EXAMPLE_ID}/mcp-grants`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "project mcp grant toggle",
    method: "PATCH",
    path: `/api/projects/${EXAMPLE_ID}/mcp-grants/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "mcp tool registration reclassify",
    method: "PATCH",
    path: `/api/mcp-tool-registrations/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  { name: "list databases", method: "GET", path: "/api/databases", surface: "api", public: false, tenancy: "tenant" },
  { name: "create database", method: "POST", path: "/api/databases", surface: "api", public: false, tenancy: "tenant" },
  {
    name: "database detail",
    method: "GET",
    path: `/api/databases/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "rename database",
    method: "PATCH",
    path: `/api/databases/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "archive database",
    method: "DELETE",
    path: `/api/databases/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "restore database",
    method: "POST",
    path: `/api/databases/${EXAMPLE_ID}/restore`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "property catalog",
    method: "GET",
    path: `/api/databases/${EXAMPLE_ID}/properties`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "create property",
    method: "POST",
    path: `/api/databases/${EXAMPLE_ID}/properties`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "property list",
    method: "GET",
    path: `/api/properties?databaseId=${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "property detail",
    method: "GET",
    path: `/api/properties/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "update property",
    method: "PATCH",
    path: `/api/properties/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "delete property",
    method: "DELETE",
    path: `/api/properties/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "list views",
    method: "GET",
    path: "/api/views",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "view detail",
    method: "GET",
    path: `/api/views/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "create view",
    method: "POST",
    path: `/api/databases/${EXAMPLE_ID}/views`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "patch view",
    method: "PATCH",
    path: `/api/views/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "delete view",
    method: "DELETE",
    path: `/api/views/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "add/reposition curated view item",
    method: "PUT",
    path: `/api/views/${EXAMPLE_ID}/items/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "reorder curated view item",
    method: "PATCH",
    path: `/api/views/${EXAMPLE_ID}/items/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "remove curated view item",
    method: "DELETE",
    path: `/api/views/${EXAMPLE_ID}/items/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "create item",
    method: "POST",
    path: `/api/databases/${EXAMPLE_ID}/items`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "item detail",
    method: "GET",
    path: `/api/items/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "patch item",
    method: "PATCH",
    path: `/api/items/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "delete item",
    method: "DELETE",
    path: `/api/items/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "restore item",
    method: "POST",
    path: `/api/items/${EXAMPLE_ID}/restore`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "query database",
    method: "POST",
    path: `/api/databases/${EXAMPLE_ID}/query`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "query view",
    method: "POST",
    path: `/api/views/${EXAMPLE_ID}/query`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "create/replace relation",
    method: "PUT",
    path: `/api/items/${EXAMPLE_ID}/relations/exampleKey/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "delete relation",
    method: "DELETE",
    path: `/api/items/${EXAMPLE_ID}/relations/exampleKey/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "upload file",
    method: "POST",
    path: "/api/files",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "download blob",
    method: "GET",
    path: `/api/blobs/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "request account export",
    method: "POST",
    path: "/api/account/exports",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "list account exports",
    method: "GET",
    path: "/api/account/exports",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "download account export",
    method: "GET",
    path: `/api/account/exports/${EXAMPLE_ID}/download`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "delete own account",
    method: "POST",
    path: "/api/account/delete",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "admin account list",
    method: "GET",
    path: "/api/admin/accounts",
    surface: "api",
    public: false,
    tenancy: "admin",
    admin: true,
  },
  {
    name: "admin operations health",
    method: "GET",
    path: "/api/admin/health",
    surface: "api",
    public: false,
    tenancy: "admin",
    admin: true,
  },
  {
    name: "admin ai budgets",
    method: "GET",
    path: "/api/admin/ai-budgets",
    surface: "api",
    public: false,
    tenancy: "admin",
    admin: true,
  },
  {
    name: "admin set ai budget",
    method: "PUT",
    path: "/api/admin/accounts/00000000-0000-0000-0000-000000000000/ai-budget",
    surface: "api",
    public: false,
    tenancy: "admin",
    admin: true,
  },
  {
    name: "admin suspend account",
    method: "POST",
    path: "/api/admin/accounts/00000000-0000-0000-0000-000000000000/suspend",
    surface: "api",
    public: false,
    tenancy: "admin",
    admin: true,
  },
  {
    name: "admin reactivate account",
    method: "POST",
    path: "/api/admin/accounts/00000000-0000-0000-0000-000000000000/reactivate",
    surface: "api",
    public: false,
    tenancy: "admin",
    admin: true,
  },
  {
    name: "admin delete account",
    method: "POST",
    path: "/api/admin/accounts/00000000-0000-0000-0000-000000000000/delete",
    surface: "api",
    public: false,
    tenancy: "admin",
    admin: true,
  },
  {
    name: "admin change account role",
    method: "PUT",
    path: "/api/admin/accounts/00000000-0000-0000-0000-000000000000/role",
    surface: "api",
    public: false,
    tenancy: "admin",
    admin: true,
  },
  {
    name: "admin create invite",
    method: "POST",
    path: "/api/admin/invites",
    surface: "api",
    public: false,
    tenancy: "admin",
    admin: true,
  },
  {
    name: "admin list invites",
    method: "GET",
    path: "/api/admin/invites",
    surface: "api",
    public: false,
    tenancy: "admin",
    admin: true,
  },
  {
    name: "admin revoke invite",
    method: "POST",
    path: "/api/admin/invites/00000000-0000-0000-0000-000000000000/revoke",
    surface: "api",
    public: false,
    tenancy: "admin",
    admin: true,
  },
  {
    name: "sync (WS upgrade)",
    method: "GET",
    path: "/api/sync",
    surface: "ws",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "Microsoft Graph mail webhook",
    method: "POST",
    path: "/api/mail/graph/webhook",
    surface: "api",
    public: true,
    tenancy: "anonymous",
    publicReason:
      "Issue #198: Microsoft Graph itself calls this with no session to deliver subscription validation and change notifications; each notification's clientState (checked in constant time) is the receiver's own authenticity check, not a session.",
  },
];
