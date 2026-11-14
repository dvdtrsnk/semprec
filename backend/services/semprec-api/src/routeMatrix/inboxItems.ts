import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

/** `ROUTE_MATRIX` slice for the `/api/inbox/items` path family. */
export const INBOX_ITEMS_ROUTES: RouteMatrixEntry[] = [
  {
    name: "change inbox item type",
    method: "PUT",
    path: `/api/inbox/items/${EXAMPLE_ID}/type`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "capture inbox item",
    method: "POST",
    path: "/api/inbox/items",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
