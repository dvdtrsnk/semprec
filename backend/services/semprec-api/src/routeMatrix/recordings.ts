import type { RouteMatrixEntry } from "../routeMatrix.js";

/** `ROUTE_MATRIX` slice for the `/api/recordings` path family. */
export const RECORDINGS_ROUTES: RouteMatrixEntry[] = [
  {
    name: "recording upload",
    method: "POST",
    path: "/api/recordings",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
