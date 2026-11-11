import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

/** `ROUTE_MATRIX` slice for the `/api/push-subscriptions` path family. */
export const PUSH_SUBSCRIPTIONS_ROUTES: RouteMatrixEntry[] = [
  {
    name: "register push subscription",
    method: "POST",
    path: "/api/push-subscriptions",
    surface: "api",
    public: false,
    tenancy: "account",
  },
  {
    name: "revoke push subscription",
    method: "POST",
    path: `/api/push-subscriptions/${EXAMPLE_ID}/revoke`,
    surface: "api",
    public: false,
    tenancy: "account",
  },
];
