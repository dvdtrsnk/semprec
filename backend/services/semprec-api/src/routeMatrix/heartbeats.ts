import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

/** `ROUTE_MATRIX` slice for the `/api/heartbeats` path family. */
export const HEARTBEATS_ROUTES: RouteMatrixEntry[] = [
  {
    name: "trigger heartbeat",
    method: "POST",
    path: `/api/heartbeats/${EXAMPLE_ID}/trigger`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "set heartbeat enabled",
    method: "PATCH",
    path: `/api/heartbeats/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
