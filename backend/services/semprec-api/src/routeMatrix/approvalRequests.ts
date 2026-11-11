import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

/** `ROUTE_MATRIX` slice for the `/api/approval-requests` path family. */
export const APPROVAL_REQUESTS_ROUTES: RouteMatrixEntry[] = [
  {
    name: "approval queue",
    method: "GET",
    path: "/api/approval-requests",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "approval decision",
    method: "PATCH",
    path: `/api/approval-requests/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
