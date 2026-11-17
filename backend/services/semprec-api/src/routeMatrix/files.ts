import type { RouteMatrixEntry } from "../routeMatrix.js";

export const FILES_ROUTES: RouteMatrixEntry[] = [
  // Also takes the optional `X-Attach-To-Item` and `X-Attach-Relation` headers.
  {
    name: "upload file",
    method: "POST",
    path: "/api/files",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
