import type { RouteMatrixEntry } from "../routeMatrix.js";

export const SEMP_STATUS_ROUTES: RouteMatrixEntry[] = [
  {
    name: "semp status",
    method: "GET",
    path: "/api/semp-status",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  // prettier-ignore
  { name: "semp status summary", method: "GET", path: "/api/semp-status/summary", surface: "api", public: false, tenancy: "tenant" },
];
