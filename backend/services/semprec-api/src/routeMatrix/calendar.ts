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
    name: "calendar agenda",
    method: "GET",
    path: "/api/calendar/agenda?from=2026-10-16&direction=forward",
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
  {
    name: "calendar invitation respond",
    method: "POST",
    path: `/api/calendar/invitations/${EXAMPLE_ID}/respond`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "calendar reminders",
    method: "GET",
    path: "/api/calendar/reminders?from=2026-10-16T00%3A00%3A00Z",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
