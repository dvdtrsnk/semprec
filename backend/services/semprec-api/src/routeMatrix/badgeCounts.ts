import type { RouteMatrixEntry } from "../routeMatrix.js";

/** `ROUTE_MATRIX` slice for the `/api/badge-counts` path family. */
export const BADGE_COUNTS_ROUTES: RouteMatrixEntry[] = [
  {
    name: "badge counts",
    method: "GET",
    path: "/api/badge-counts",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
