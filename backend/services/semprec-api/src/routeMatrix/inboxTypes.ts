import type { RouteMatrixEntry } from "../routeMatrix.js";

/** `ROUTE_MATRIX` slice for the `/api/inbox-types` path family. */
export const INBOX_TYPES_ROUTES: RouteMatrixEntry[] = [
  {
    name: "inbox types",
    method: "GET",
    path: "/api/inbox-types",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
