import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

/**
 * `ROUTE_MATRIX` slice for the `/api/views` path family, together with view creation under
 * `/api/databases/:id/views`. The view query entry is in `items.ts`.
 */
export const VIEWS_ROUTES: RouteMatrixEntry[] = [
  {
    name: "list views",
    method: "GET",
    path: "/api/views",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "view detail",
    method: "GET",
    path: `/api/views/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "create view",
    method: "POST",
    path: `/api/databases/${EXAMPLE_ID}/views`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "patch view",
    method: "PATCH",
    path: `/api/views/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "delete view",
    method: "DELETE",
    path: `/api/views/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "add/reposition curated view item",
    method: "PUT",
    path: `/api/views/${EXAMPLE_ID}/items/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "reorder curated view item",
    method: "PATCH",
    path: `/api/views/${EXAMPLE_ID}/items/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "remove curated view item",
    method: "DELETE",
    path: `/api/views/${EXAMPLE_ID}/items/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
