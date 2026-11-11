import type { RouteMatrixEntry } from "../routeMatrix.js";

/** `ROUTE_MATRIX` slice for the `/healthz` path family. */
export const HEALTHZ_ROUTES: RouteMatrixEntry[] = [
  {
    name: "shallow health check",
    method: "GET",
    path: "/healthz",
    surface: "api",
    public: true,
    tenancy: "anonymous",
    publicReason:
      "Issue #168: a deployment/orchestrator probe run with no session — its only content is a status word, never account or deployment detail.",
  },
];
