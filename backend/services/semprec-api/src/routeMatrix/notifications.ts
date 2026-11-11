import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

/** `ROUTE_MATRIX` slice for the `/api/notifications` path family. */
export const NOTIFICATIONS_ROUTES: RouteMatrixEntry[] = [
  {
    name: "unread notifications",
    method: "GET",
    path: "/api/notifications/unread",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "resolved notifications",
    method: "GET",
    path: "/api/notifications/resolved",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "visit notification",
    method: "POST",
    path: `/api/notifications/${EXAMPLE_ID}/visit`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "mark all notifications read",
    method: "POST",
    path: "/api/notifications/mark-all-read",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
