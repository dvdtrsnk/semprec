import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

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
