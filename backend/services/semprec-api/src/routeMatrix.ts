/**
 * The single documented artifact issue #143 asks for: every HTTP route this service answers,
 * and whether it is reachable without a session. `__tests__/routeMatrix.test.ts` drives this
 * list end to end against the real dispatcher (`app.ts`'s `createDispatcher`) — an entry with
 * `public: false` that a handler doesn't actually gate behind `authenticateRequest` fails that
 * test with a non-401 response, and a newly added route that's never added here simply isn't
 * covered, so adding a route always means adding (and justifying) an entry.
 *
 * Non-HTTP surfaces inventoried for issue #143 and found not to apply, so they have no entries
 * below:
 * - WS-upgrade: `@semprec/realtime`'s `startRealtimeServer` (`backend/packages/realtime`) wires
 *   Postgres LISTEN/NOTIFY to a caller-supplied `WebSocketServer`, but nothing in this service
 *   (or anywhere else in the repo) actually constructs one or handles the HTTP `upgrade` event —
 *   there is no live WS route to protect yet.
 * - Module routes: `ModuleRegistry` (`backend/packages/module-registry`) is in-process only —
 *   `loadModule()` does a plain dynamic `import()` of caller-supplied file paths, and every
 *   other method returns typed data to other backend code. It never opens a socket.
 * - View paths: the web client (`web/`) has no router and no login page yet — every page is a
 *   query-param-selected React component with no per-view auth guard. The only view path
 *   auth-v1 actually delivered is the `/setup` wizard (issue #234), which stays public by design
 *   (see `POST /api/setup` below) same as its API. Gating the client's other views is a
 *   follow-up for whichever issue adds a login page; this service's routes are what auth-v1 #143
 *   can enforce today, and every read/write those views depend on is in the table below.
 * - Health-style probes: none exist in this service today. If one is added later, it belongs in
 *   this table as `public: true` with a `publicReason`, same as everything else here.
 */
export interface RouteMatrixEntry {
  /** For docs/failure messages only — matching is driven by `method` + `path` below. */
  name: string;
  method: string;
  /** A concrete, requestable path — any `:id`-style segment is filled with a syntactically valid but nonexistent id. */
  path: string;
  /** `false` (the default expectation) means an unauthenticated request must get a 401. */
  public: boolean;
  /** Required when `public` is true — why this route is one of the documented exceptions. */
  publicReason?: string;
}

const EXAMPLE_ID = "00000000-0000-0000-0000-000000000000";

export const ROUTE_MATRIX: RouteMatrixEntry[] = [
  {
    name: "login",
    method: "POST",
    path: "/api/auth/login",
    public: true,
    publicReason: "Issue #140: logging in is necessarily unauthenticated — it's how a session is obtained.",
  },
  {
    name: "password-reset request",
    method: "POST",
    path: "/api/auth/password-reset/request",
    public: true,
    publicReason:
      "Issue #142: a forgotten password means there's no session yet; the response never reveals whether the email exists.",
  },
  {
    name: "password-reset consume",
    method: "POST",
    path: "/api/auth/password-reset/consume",
    public: true,
    publicReason: "Issue #142: the single-use reset token itself is the credential presented here, not a session.",
  },
  {
    name: "first-account setup",
    method: "POST",
    path: "/api/setup",
    public: true,
    publicReason:
      "Issue #233: there is no user yet to authenticate as. Gated instead by SETUP_TOKEN and a hard 404 once any user exists.",
  },
  { name: "logout", method: "POST", path: "/api/auth/logout", public: false },
  { name: "revoke session", method: "POST", path: `/api/auth/sessions/${EXAMPLE_ID}/revoke`, public: false },
  { name: "current session", method: "GET", path: "/api/auth/session", public: false },
  { name: "ai usage report", method: "GET", path: "/api/ai-usage?from=2026-01-01&to=2026-01-02", public: false },
  { name: "approval queue", method: "GET", path: "/api/approval-requests", public: false },
  { name: "approval decision", method: "PATCH", path: `/api/approval-requests/${EXAMPLE_ID}`, public: false },
  { name: "agent run detail", method: "GET", path: `/api/agent-runs/${EXAMPLE_ID}`, public: false },
  { name: "project mcp grants", method: "GET", path: `/api/projects/${EXAMPLE_ID}/mcp-grants`, public: false },
  {
    name: "project mcp grant toggle",
    method: "PATCH",
    path: `/api/projects/${EXAMPLE_ID}/mcp-grants/${EXAMPLE_ID}`,
    public: false,
  },
  {
    name: "mcp tool registration reclassify",
    method: "PATCH",
    path: `/api/mcp-tool-registrations/${EXAMPLE_ID}`,
    public: false,
  },
];
