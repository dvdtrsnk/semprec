import type { RouteMatrixEntry } from "../routeMatrix.js";

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
