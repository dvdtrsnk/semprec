import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

/** `ROUTE_MATRIX` slice for the `/api/semp` path family. */
export const SEMP_ROUTES: RouteMatrixEntry[] = [
  // prettier-ignore
  { name: "semp thread create message", method: "POST", path: "/api/semp/threads", surface: "api", public: false, tenancy: "tenant" },
  // prettier-ignore
  { name: "semp thread send message", method: "POST", path: `/api/semp/threads/${EXAMPLE_ID}/messages`, surface: "api", public: false, tenancy: "tenant" },
  // prettier-ignore
  { name: "semp message speech", method: "POST", path: `/api/semp/threads/${EXAMPLE_ID}/messages/${EXAMPLE_ID}/speech`, surface: "api", public: false, tenancy: "tenant" },
  {
    name: "semp thread detail",
    method: "GET",
    path: `/api/semp/threads/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "semp thread messages",
    method: "GET",
    path: `/api/semp/threads/${EXAMPLE_ID}/messages`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "semp thread list",
    method: "GET",
    path: "/api/semp/threads",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  // prettier-ignore
  { name: "semp message retry", method: "POST", path: `/api/semp/threads/${EXAMPLE_ID}/messages/${EXAMPLE_ID}/retry`, surface: "api", public: false, tenancy: "tenant" },
  // prettier-ignore
  { name: "semp message regenerate", method: "POST", path: `/api/semp/threads/${EXAMPLE_ID}/messages/${EXAMPLE_ID}/regenerate`, surface: "api", public: false, tenancy: "tenant" },
];
