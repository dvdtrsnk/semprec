import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

/**
 * `ROUTE_MATRIX` slice for the agent-guidance path family: `/api/projects/:id/agent-guidance` and
 * `/api/agent-guidance-drift`.
 */
export const AGENT_GUIDANCE_ROUTES: RouteMatrixEntry[] = [
  // prettier-ignore
  { name: "project guidance read", method: "GET", path: `/api/projects/${EXAMPLE_ID}/agent-guidance`, surface: "api", public: false, tenancy: "tenant" },
  {
    name: "project guidance save",
    method: "PUT",
    path: `/api/projects/${EXAMPLE_ID}/agent-guidance`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  // prettier-ignore
  { name: "project guidance drift read", method: "GET", path: `/api/projects/${EXAMPLE_ID}/agent-guidance/drift`, surface: "api", public: false, tenancy: "tenant" },
  // prettier-ignore
  { name: "guidance drift resolve", method: "POST", path: `/api/agent-guidance-drift/${EXAMPLE_ID}/resolve`, surface: "api", public: false, tenancy: "tenant" },
];
