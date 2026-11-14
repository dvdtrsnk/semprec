import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

/** `ROUTE_MATRIX` slice for the `/api/mcp-servers` path family. */
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
