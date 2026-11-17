import type { RouteMatrixEntry } from "../routeMatrix.js";

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
