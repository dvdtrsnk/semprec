import type { RouteMatrixEntry } from "../routeMatrix.js";

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
