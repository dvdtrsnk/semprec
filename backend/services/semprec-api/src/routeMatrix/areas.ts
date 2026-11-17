import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

export const AREAS_ROUTES: RouteMatrixEntry[] = [
  {
    name: "area overview",
    method: "GET",
    path: `/api/areas/${EXAMPLE_ID}/overview`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
