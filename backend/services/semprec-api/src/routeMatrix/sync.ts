import type { RouteMatrixEntry } from "../routeMatrix.js";

/** `ROUTE_MATRIX` slice for the `/api/sync` path family. */
export const SYNC_ROUTES: RouteMatrixEntry[] = [
  {
    name: "sync (WS upgrade)",
    method: "GET",
    path: "/api/sync",
    surface: "ws",
    public: false,
    tenancy: "tenant",
  },
];
