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
  {
    name: "reject proposal",
    method: "POST",
    path: `/api/proposals/${EXAMPLE_ID}/reject`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "reopen proposal",
    method: "POST",
    path: `/api/proposals/${EXAMPLE_ID}/reopen`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "revise proposal",
    method: "POST",
    path: `/api/proposals/${EXAMPLE_ID}/revise`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "reset proposal overrides",
    method: "POST",
    path: `/api/proposals/${EXAMPLE_ID}/reset-overrides`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "recompute proposal",
    method: "POST",
    path: `/api/proposals/${EXAMPLE_ID}/recompute`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "update proposal values",
    method: "PATCH",
    path: `/api/proposals/${EXAMPLE_ID}/values`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
