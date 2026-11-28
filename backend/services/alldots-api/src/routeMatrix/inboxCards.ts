import type { RouteMatrixEntry } from "../routeMatrix.js";

export const INBOX_CARDS_ROUTES: RouteMatrixEntry[] = [
  {
    name: "inbox cards",
    method: "GET",
    path: "/api/inbox/cards",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "inbox cards count",
    method: "GET",
    path: "/api/inbox/cards/count",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
