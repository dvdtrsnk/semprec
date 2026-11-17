import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

export const PROJECT_AGENT_SUMMARY_ROUTES: RouteMatrixEntry[] = [
  // prettier-ignore
  { name: "project agent summary", method: "GET", path: `/api/projects/${EXAMPLE_ID}/agent-summary`, surface: "api", public: false, tenancy: "tenant" },
];
