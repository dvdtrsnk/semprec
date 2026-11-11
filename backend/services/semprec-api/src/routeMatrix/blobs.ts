import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

/** `ROUTE_MATRIX` slice for the `/api/blobs` path family. */
export const BLOBS_ROUTES: RouteMatrixEntry[] = [
  {
    name: "upload blob",
    method: "POST",
    path: "/api/blobs",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "download blob",
    method: "GET",
    path: `/api/blobs/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
