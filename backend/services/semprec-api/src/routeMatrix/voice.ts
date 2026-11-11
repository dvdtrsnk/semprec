import type { RouteMatrixEntry } from "../routeMatrix.js";

/** `ROUTE_MATRIX` slice for the `/api/voice` path family. */
export const VOICE_ROUTES: RouteMatrixEntry[] = [
  {
    name: "voice (WS upgrade)",
    method: "GET",
    path: "/api/voice",
    surface: "ws",
    public: false,
    tenancy: "tenant",
  },
];
