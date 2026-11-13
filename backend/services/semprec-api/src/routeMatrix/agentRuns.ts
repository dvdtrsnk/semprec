import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

/** `ROUTE_MATRIX` slice for the `/api/agent-runs` path family. */
export const AGENT_RUNS_ROUTES: RouteMatrixEntry[] = [
  {
    name: "agent run detail",
    method: "GET",
    path: `/api/agent-runs/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "agent run steps",
    method: "GET",
    path: `/api/agent-runs/${EXAMPLE_ID}/steps`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "mint mcp run credential",
    method: "POST",
    path: "/api/agent-runs/mcp-credentials",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
