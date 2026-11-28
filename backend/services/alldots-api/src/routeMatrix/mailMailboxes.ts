import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

/** Placed apart from the other mail entries by the matrix order. */
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
  {
    name: "mailbox password replace",
    method: "PUT",
    path: `/api/mail/mailboxes/${EXAMPLE_ID}/password`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
