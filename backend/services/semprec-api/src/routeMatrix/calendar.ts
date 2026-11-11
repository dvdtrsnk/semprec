import type { RouteMatrixEntry } from "../routeMatrix.js";

/** `ROUTE_MATRIX` slice for the `/api/calendar` path family. */
export const CALENDAR_ROUTES: RouteMatrixEntry[] = [
  {
    name: "calendar timeline",
    method: "GET",
    path: "/api/calendar/timeline?from=2026-10-16&to=2026-10-16",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
