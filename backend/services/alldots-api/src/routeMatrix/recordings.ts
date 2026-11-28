import type { RouteMatrixEntry } from "../routeMatrix.js";

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
