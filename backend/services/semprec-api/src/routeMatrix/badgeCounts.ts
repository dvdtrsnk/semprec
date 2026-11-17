import type { RouteMatrixEntry } from "../routeMatrix.js";

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
