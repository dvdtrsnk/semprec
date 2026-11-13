import type { RouteMatrixEntry } from "../routeMatrix.js";

/** `ROUTE_MATRIX` slice for the `/api/overview` path family. */
export const OVERVIEW_ROUTES: RouteMatrixEntry[] = [
  {
    name: "overview summary",
    method: "GET",
    path: "/api/overview",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
