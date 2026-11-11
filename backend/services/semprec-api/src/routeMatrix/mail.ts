import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

/**
 * `ROUTE_MATRIX` slice for the `/api/mail` path family, except the mailbox list, detail and password connect
 * entries in `mailMailboxes.ts`.
 */
export const MAIL_ROUTES: RouteMatrixEntry[] = [
  // prettier-ignore
  { name: "mail autonomous send projects", method: "GET", path: "/api/mail/autonomous-send-projects", surface: "api", public: false, tenancy: "tenant" },
  {
    name: "mail contacts",
    method: "GET",
    path: "/api/mail/contacts?q=contact",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "mail threads",
    method: "GET",
    path: "/api/mail/threads",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  // prettier-ignore
  { name: "mail thread detail", method: "GET", path: `/api/mail/threads/${EXAMPLE_ID}`, surface: "api", public: false, tenancy: "tenant" },
  {
    name: "mailbox removal impact",
    method: "GET",
    path: "/api/mail/mailboxes/00000000-0000-0000-0000-000000000000/removal-impact",
    surface: "api",
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
  {
    name: "mail oauth start",
    method: "POST",
    path: "/api/mail/mailboxes/oauth/start",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "mail oauth complete",
    method: "POST",
    path: "/api/mail/mailboxes/oauth/complete",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "mail oauth callback",
    method: "GET",
    path: "/api/mail/oauth/callback?code=example-code&state=example-state",
    surface: "api",
    public: true,
    tenancy: "anonymous",
    publicReason:
      "Issue gh-1686: Google or Microsoft redirects the browser here after the sign-in, before the app holds the result, so no session is required. The handler reads no row and no session and writes nothing; it only passes the code and state on, and the authenticated POST /api/mail/mailboxes/oauth/complete checks the state against the signed-in user.",
  },
  {
    name: "mail summary",
    method: "GET",
    path: "/api/mail/summary",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "mailbox folder list",
    method: "GET",
    path: `/api/mail/mailboxes/${EXAMPLE_ID}/folders`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "mailbox removal",
    method: "DELETE",
    path: `/api/mail/mailboxes/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "mailbox reauthorize",
    method: "POST",
    path: `/api/mail/mailboxes/${EXAMPLE_ID}/reauthorize`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "mail thread facets",
    method: "GET",
    path: "/api/mail/threads/facets",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
