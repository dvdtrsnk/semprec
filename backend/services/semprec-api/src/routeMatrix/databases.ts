import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

/**
 * `ROUTE_MATRIX` slice for the `/api/databases` path family. The entries under `/api/databases/:id/` that address
 * properties, views, items or a query are in `properties.ts`, `views.ts` and `items.ts`.
 */
export const DATABASES_ROUTES: RouteMatrixEntry[] = [
  { name: "list databases", method: "GET", path: "/api/databases", surface: "api", public: false, tenancy: "tenant" },
  { name: "create database", method: "POST", path: "/api/databases", surface: "api", public: false, tenancy: "tenant" },
  {
    name: "database detail",
    method: "GET",
    path: `/api/databases/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "rename database",
    method: "PATCH",
    path: `/api/databases/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "archive database",
    method: "DELETE",
    path: `/api/databases/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "restore database",
    method: "POST",
    path: `/api/databases/${EXAMPLE_ID}/restore`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
