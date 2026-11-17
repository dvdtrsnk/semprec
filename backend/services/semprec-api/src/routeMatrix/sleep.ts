import type { RouteMatrixEntry } from "../routeMatrix.js";

export const SLEEP_ROUTES: RouteMatrixEntry[] = [
  {
    name: "sleep nights",
    method: "GET",
    path: "/api/sleep/nights?from=2026-10-15&to=2026-10-16",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "sleep night put",
    method: "PUT",
    path: "/api/sleep/nights/2026-10-16",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
