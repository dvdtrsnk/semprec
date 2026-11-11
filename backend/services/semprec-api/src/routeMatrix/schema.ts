import type { RouteMatrixEntry } from "../routeMatrix.js";

/** `ROUTE_MATRIX` slice for the `/api/schema` path family. */
export const SCHEMA_ROUTES: RouteMatrixEntry[] = [
  {
    name: "schema projection",
    method: "GET",
    path: "/api/schema",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
