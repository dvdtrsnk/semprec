import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

/** `ROUTE_MATRIX` slice for the `/api/transcript-summaries` path family. */
export const TRANSCRIPT_SUMMARIES_ROUTES: RouteMatrixEntry[] = [
  {
    name: "transcript summaries",
    method: "GET",
    path: `/api/transcript-summaries?eventIds=${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
