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
  {
    name: "library cover candidates list",
    method: "GET",
    path: `/api/items/${EXAMPLE_ID}/cover-candidates`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "library cover candidates refresh",
    method: "POST",
    path: `/api/items/${EXAMPLE_ID}/cover-candidates/refresh`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "library cover candidate select",
    method: "POST",
    path: `/api/items/${EXAMPLE_ID}/cover-candidates/0/select`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
