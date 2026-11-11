import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

/** `ROUTE_MATRIX` slice for the `/api/tasks` path family. */
export const TASKS_ROUTES: RouteMatrixEntry[] = [
  // prettier-ignore
  { name: "task recurrence set", method: "PUT", path: `/api/tasks/${EXAMPLE_ID}/recurrence`, surface: "api", public: false, tenancy: "tenant" },
  // prettier-ignore
  { name: "task series edit", method: "PATCH", path: `/api/tasks/series/${EXAMPLE_ID}`, surface: "api", public: false, tenancy: "tenant" },
  // prettier-ignore
  { name: "task recurrence clear", method: "DELETE", path: `/api/tasks/${EXAMPLE_ID}/recurrence`, surface: "api", public: false, tenancy: "tenant" },
  // prettier-ignore
  { name: "task occurrence materialize", method: "POST", path: `/api/tasks/series/${EXAMPLE_ID}/occurrences/2026-10-25`, surface: "api", public: false, tenancy: "tenant" },
  // prettier-ignore
  { name: "task host event put", method: "PUT", path: `/api/tasks/${EXAMPLE_ID}/host-events/${EXAMPLE_ID}`, surface: "api", public: false, tenancy: "tenant" },
  // prettier-ignore
  { name: "task host event remove", method: "DELETE", path: `/api/tasks/${EXAMPLE_ID}/host-events/${EXAMPLE_ID}`, surface: "api", public: false, tenancy: "tenant" },
  // prettier-ignore
  { name: "task host events clear", method: "DELETE", path: `/api/tasks/${EXAMPLE_ID}/host-events`, surface: "api", public: false, tenancy: "tenant" },
];
