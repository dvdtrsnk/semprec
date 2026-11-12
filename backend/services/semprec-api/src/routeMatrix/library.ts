import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

/** `ROUTE_MATRIX` slice for the routes of the library module (Books and Movies/TV). */
export const LIBRARY_ROUTES: RouteMatrixEntry[] = [
  {
    name: "library automation retry",
    method: "POST",
    path: `/api/items/${EXAMPLE_ID}/automation/retry`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
