import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

export const MCP_SERVERS_ROUTES: RouteMatrixEntry[] = [
  {
    name: "mcp server sync",
    method: "POST",
    path: `/api/mcp-servers/${EXAMPLE_ID}/sync`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
