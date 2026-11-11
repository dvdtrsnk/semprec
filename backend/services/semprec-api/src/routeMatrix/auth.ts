import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

/**
 * `ROUTE_MATRIX` slice for the `/api/auth` path family, together with the entries the matrix order places among
 * them: first-account setup (`/api/setup` and its wizard view) and `/api/invitations/accept`.
 */
export const AUTH_ROUTES: RouteMatrixEntry[] = [
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
  {
    name: "accept invitation",
    method: "POST",
    path: "/api/invitations/accept",
    surface: "api",
    public: true,
    tenancy: "anonymous",
    publicReason:
      "Issue #1087: the invitee has no session yet. The single-use invitation token is the credential, and every unusable token gets the same 404.",
  },
  { name: "logout", method: "POST", path: "/api/auth/logout", surface: "api", public: false, tenancy: "account" },
  {
    name: "list sessions",
    method: "GET",
    path: "/api/auth/sessions",
    surface: "api",
    public: false,
    tenancy: "account",
  },
  {
    name: "revoke session",
    method: "POST",
    path: `/api/auth/sessions/${EXAMPLE_ID}/revoke`,
    surface: "api",
    public: false,
    tenancy: "account",
  },
  // prettier-ignore
  { name: "revoke other sessions", method: "POST", path: "/api/auth/sessions/revoke-others", surface: "api", public: false, tenancy: "account" },
  {
    name: "set self person",
    method: "PUT",
    path: "/api/auth/self-person",
    surface: "api",
    public: false,
    tenancy: "tenant",
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
    name: "change password",
    method: "POST",
    path: "/api/auth/password-change",
    surface: "api",
    public: false,
    tenancy: "account",
  },
];
