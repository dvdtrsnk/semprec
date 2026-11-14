import type { RouteMatrixEntry } from "../routeMatrix.js";

/** `ROUTE_MATRIX` slice for the `/api/trash` path family. */
export const TRASH_ROUTES: RouteMatrixEntry[] = [
  {
    name: "list trash items",
    method: "GET",
    path: "/api/trash/items",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "list trash databases",
    method: "GET",
    path: "/api/trash/databases",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "restore trash",
    method: "POST",
    path: "/api/trash/restore",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
