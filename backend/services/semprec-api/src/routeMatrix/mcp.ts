import type { RouteMatrixEntry } from "../routeMatrix.js";

/** `ROUTE_MATRIX` slice for the `/mcp` path family. */
export const MCP_ROUTES: RouteMatrixEntry[] = [
  { name: "mcp json-rpc endpoint", method: "POST", path: "/mcp", surface: "api", public: false, tenancy: "tenant" },
];
