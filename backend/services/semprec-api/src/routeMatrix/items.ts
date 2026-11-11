import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

/**
 * `ROUTE_MATRIX` slice for the `/api/items` path family, together with item creation under
 * `/api/databases/:id/items` and the two query entries the matrix order places among them
 * (`/api/databases/:id/query` and `/api/views/:id/query`).
 */
export const ITEMS_ROUTES: RouteMatrixEntry[] = [
  {
    name: "create item",
    method: "POST",
    path: `/api/databases/${EXAMPLE_ID}/items`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "item detail",
    method: "GET",
    path: `/api/items/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "patch item",
    method: "PATCH",
    path: `/api/items/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "delete item",
    method: "DELETE",
    path: `/api/items/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "restore item",
    method: "POST",
    path: `/api/items/${EXAMPLE_ID}/restore`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "query database",
    method: "POST",
    path: `/api/databases/${EXAMPLE_ID}/query`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "query view",
    method: "POST",
    path: `/api/views/${EXAMPLE_ID}/query`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  ...(["unlink", "relink"] as const).map((action): RouteMatrixEntry => ({
    name: `${action} value`,
    method: "POST",
    path: `/api/items/${EXAMPLE_ID}/links/exampleKey/${action}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  })),
  {
    name: "set relation",
    method: "PUT",
    path: `/api/items/${EXAMPLE_ID}/relations/exampleKey`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "create/replace relation",
    method: "PUT",
    path: `/api/items/${EXAMPLE_ID}/relations/exampleKey/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "delete relation",
    method: "DELETE",
    path: `/api/items/${EXAMPLE_ID}/relations/exampleKey/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "list relations",
    method: "GET",
    path: `/api/items/${EXAMPLE_ID}/relations`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  // prettier-ignore
  { name: "ensure page", method: "PUT", path: `/api/items/${EXAMPLE_ID}/page`, surface: "api", public: false, tenancy: "tenant" },
  // prettier-ignore
  { name: "get page", method: "GET", path: `/api/items/${EXAMPLE_ID}/page`, surface: "api", public: false, tenancy: "tenant" },
  // prettier-ignore
  { name: "read page markdown", method: "GET", path: `/api/items/${EXAMPLE_ID}/page.md`, surface: "api", public: false, tenancy: "tenant" },
  // prettier-ignore
  { name: "insert page markdown", method: "POST", path: `/api/items/${EXAMPLE_ID}/page/insert`, surface: "api", public: false, tenancy: "tenant" },
  // prettier-ignore
  { name: "list page changes", method: "GET", path: `/api/items/${EXAMPLE_ID}/page/changes`, surface: "api", public: false, tenancy: "tenant" },
  // prettier-ignore
  { name: "create subpage", method: "POST", path: `/api/items/${EXAMPLE_ID}/page/subpages`, surface: "api", public: false, tenancy: "tenant" },
  // prettier-ignore
  { name: "restore page version", method: "POST", path: `/api/items/${EXAMPLE_ID}/page/restore`, surface: "api", public: false, tenancy: "tenant" },
  { name: "count items", method: "POST", path: "/api/items/count", surface: "api", public: false, tenancy: "tenant" },
  // prettier-ignore
  { name: "duplicate page", method: "POST", path: `/api/items/${EXAMPLE_ID}/page/duplicate`, surface: "api", public: false, tenancy: "tenant" },
  // prettier-ignore
  { name: "rename page", method: "PATCH", path: `/api/items/${EXAMPLE_ID}/page/title`, surface: "api", public: false, tenancy: "tenant" },
];
