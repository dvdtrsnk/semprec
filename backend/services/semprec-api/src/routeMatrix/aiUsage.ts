import type { RouteMatrixEntry } from "../routeMatrix.js";

/** `ROUTE_MATRIX` slice for the `/api/ai-usage` path family. */
export const AI_USAGE_ROUTES: RouteMatrixEntry[] = [
  {
    name: "ai usage report",
    method: "GET",
    path: "/api/ai-usage?from=2026-01-01&to=2026-01-02",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "ai usage summary",
    method: "GET",
    path: "/api/ai-usage/summary",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
