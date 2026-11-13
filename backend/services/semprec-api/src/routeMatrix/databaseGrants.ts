import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

/** `ROUTE_MATRIX` slice for the `/api/projects/:id/database-grants` path family. */
export const DATABASE_GRANTS_ROUTES: RouteMatrixEntry[] = [
  {
    name: "project database grants",
    method: "GET",
    path: `/api/projects/${EXAMPLE_ID}/database-grants`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "project database grant set",
    method: "PATCH",
    path: `/api/projects/${EXAMPLE_ID}/database-grants`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
