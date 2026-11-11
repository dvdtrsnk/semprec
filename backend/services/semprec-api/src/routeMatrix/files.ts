import type { RouteMatrixEntry } from "../routeMatrix.js";

/** `ROUTE_MATRIX` slice for the `/api/files` path family. */
export const FILES_ROUTES: RouteMatrixEntry[] = [
  // Also takes the optional `X-Attach-To-Item` and `X-Attach-Relation` headers (issue #1645), which link the
  // upload to an item in the same request; tenantIsolationRoutes.test.ts answers a foreign target like a random one.
  {
    name: "upload file",
    method: "POST",
    path: "/api/files",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
