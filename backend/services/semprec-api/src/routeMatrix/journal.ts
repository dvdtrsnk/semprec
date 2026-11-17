import type { RouteMatrixEntry } from "../routeMatrix.js";

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
