import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

/** `ROUTE_MATRIX` slice for the `/api/proposals` path family. */
export const PROPOSALS_ROUTES: RouteMatrixEntry[] = [
  {
    name: "confirm proposal",
    method: "POST",
    path: `/api/proposals/${EXAMPLE_ID}/confirm`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
