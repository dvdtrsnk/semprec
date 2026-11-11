import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

/**
 * `ROUTE_MATRIX` slice for `/api/mail/mailboxes`: the mailbox list, detail and password connect entries, which the
 * matrix order places apart from the other mail entries in `mail.ts`.
 */
export const MAIL_MAILBOXES_ROUTES: RouteMatrixEntry[] = [
  {
    name: "mailbox list",
    method: "GET",
    path: "/api/mail/mailboxes",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "mailbox detail",
    method: "GET",
    path: `/api/mail/mailboxes/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "mailbox password connect",
    method: "POST",
    path: "/api/mail/mailboxes",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
