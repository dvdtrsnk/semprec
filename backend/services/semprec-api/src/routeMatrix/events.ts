import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

/** `ROUTE_MATRIX` slice for the `/api/events` path family. */
export const EVENTS_ROUTES: RouteMatrixEntry[] = [
  {
    name: "event people",
    method: "GET",
    path: `/api/events/${EXAMPLE_ID}/people`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "event transcript action items",
    method: "GET",
    path: `/api/events/${EXAMPLE_ID}/transcript-action-items`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "event tasks",
    method: "GET",
    path: `/api/events/${EXAMPLE_ID}/tasks`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
