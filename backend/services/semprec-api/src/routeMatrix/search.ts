import type { RouteMatrixEntry } from "../routeMatrix.js";

export const SEARCH_ROUTES: RouteMatrixEntry[] = [
  {
    name: "global search",
    method: "GET",
    path: "/api/search?q=invoice",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
