import type { RouteMatrixEntry } from "../routeMatrix.js";

export const MCP_ROUTES: RouteMatrixEntry[] = [
  { name: "mcp json-rpc endpoint", method: "POST", path: "/mcp", surface: "api", public: false, tenancy: "tenant" },
];
