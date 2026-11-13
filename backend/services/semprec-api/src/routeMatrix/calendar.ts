import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

/** `ROUTE_MATRIX` slice for the `/api/calendar` path family. */
export const CALENDAR_ROUTES: RouteMatrixEntry[] = [
  {
    name: "calendar timeline",
    method: "GET",
    path: "/api/calendar/timeline?from=2026-10-16&to=2026-10-16",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "calendar item duplicate",
    method: "POST",
    path: `/api/calendar/items/${EXAMPLE_ID}/duplicate`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "calendar cancellation impact",
    method: "GET",
    path: `/api/calendar/calendars/${EXAMPLE_ID}/cancellation-impact`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
