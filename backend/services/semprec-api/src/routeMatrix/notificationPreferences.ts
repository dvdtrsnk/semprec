import type { RouteMatrixEntry } from "../routeMatrix.js";

/** `ROUTE_MATRIX` slice for the `/api/notification-preferences` path family. */
export const NOTIFICATION_PREFERENCES_ROUTES: RouteMatrixEntry[] = [
  {
    name: "get notification preferences",
    method: "GET",
    path: "/api/notification-preferences",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "patch notification preferences",
    method: "PATCH",
    path: "/api/notification-preferences",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
