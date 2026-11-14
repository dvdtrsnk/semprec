import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

/** `ROUTE_MATRIX` slice for the `/api/projects/:id/heartbeats` path family. */
export const PROJECT_HEARTBEATS_ROUTES: RouteMatrixEntry[] = [
  // prettier-ignore
  { name: "project heartbeats", method: "GET", path: `/api/projects/${EXAMPLE_ID}/heartbeats`, surface: "api", public: false, tenancy: "tenant" },
];
