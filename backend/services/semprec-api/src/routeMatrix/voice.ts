import type { RouteMatrixEntry } from "../routeMatrix.js";

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
