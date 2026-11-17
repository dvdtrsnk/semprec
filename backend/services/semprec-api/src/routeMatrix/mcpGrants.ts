import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

export const MCP_GRANTS_ROUTES: RouteMatrixEntry[] = [
  {
    name: "project mcp grants",
    method: "GET",
    path: `/api/projects/${EXAMPLE_ID}/mcp-grants`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "project mcp grant toggle",
    method: "PATCH",
    path: `/api/projects/${EXAMPLE_ID}/mcp-grants/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
