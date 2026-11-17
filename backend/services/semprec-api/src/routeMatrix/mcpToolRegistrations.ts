import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

export const MCP_TOOL_REGISTRATIONS_ROUTES: RouteMatrixEntry[] = [
  {
    name: "mcp tool registration reclassify",
    method: "PATCH",
    path: `/api/mcp-tool-registrations/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
