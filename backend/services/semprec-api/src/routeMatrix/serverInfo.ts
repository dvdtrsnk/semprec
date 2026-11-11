import type { RouteMatrixEntry } from "../routeMatrix.js";

/** `ROUTE_MATRIX` slice for the `/api/server-info` path family. */
export const SERVER_INFO_ROUTES: RouteMatrixEntry[] = [
  {
    name: "server identity",
    method: "GET",
    path: "/api/server-info",
    surface: "api",
    public: true,
    tenancy: "anonymous",
    publicReason:
      "Issue #1355: clients must confirm a server address before they have a session; the body contains only the product name.",
  },
];
