import type { RouteMatrixEntry } from "../routeMatrix.js";

/** `ROUTE_MATRIX` slice for the `/api/journal` path family. */
export const JOURNAL_ROUTES: RouteMatrixEntry[] = [
  {
    name: "journal period ensure",
    method: "PUT",
    path: "/api/journal/periods/day/2026-10-16/doc",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "journal period read",
    method: "GET",
    path: "/api/journal/periods/day/2026-10-16",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
