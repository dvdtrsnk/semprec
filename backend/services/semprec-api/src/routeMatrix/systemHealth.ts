import type { RouteMatrixEntry } from "../routeMatrix.js";

/** `ROUTE_MATRIX` slice for the `/api/system-health` path family. */
export const SYSTEM_HEALTH_ROUTES: RouteMatrixEntry[] = [
  {
    name: "system health report",
    method: "GET",
    path: "/api/system-health",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
