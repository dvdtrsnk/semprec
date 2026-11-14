import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

/** `ROUTE_MATRIX` slice for the `/api/account` path family. */
export const ACCOUNT_ROUTES: RouteMatrixEntry[] = [
  {
    name: "request account export",
    method: "POST",
    path: "/api/account/exports",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "list account exports",
    method: "GET",
    path: "/api/account/exports",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "download account export",
    method: "GET",
    path: `/api/account/exports/${EXAMPLE_ID}/download`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "account summary",
    method: "GET",
    path: "/api/account/summary",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "delete own account",
    method: "POST",
    path: "/api/account/delete",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "update profile",
    method: "PATCH",
    path: "/api/account/profile",
    surface: "api",
    public: false,
    tenancy: "account",
  },
];
