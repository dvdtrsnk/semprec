import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

/**
 * `ROUTE_MATRIX` slice for the `/api/properties` path family, together with the property entries under
 * `/api/databases/:id/properties`.
 */
export const PROPERTIES_ROUTES: RouteMatrixEntry[] = [
  {
    name: "property catalog",
    method: "GET",
    path: `/api/databases/${EXAMPLE_ID}/properties`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "create property",
    method: "POST",
    path: `/api/databases/${EXAMPLE_ID}/properties`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "property list",
    method: "GET",
    path: `/api/properties?databaseId=${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "property detail",
    method: "GET",
    path: `/api/properties/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "update property",
    method: "PATCH",
    path: `/api/properties/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "delete property",
    method: "DELETE",
    path: `/api/properties/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
