import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

/** `ROUTE_MATRIX` slice for the `/api/transcriptions` path family. */
export const TRANSCRIPTIONS_ROUTES: RouteMatrixEntry[] = [
  {
    name: "create transcription",
    method: "POST",
    path: "/api/transcriptions",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "transcription rerun",
    method: "POST",
    path: `/api/transcriptions/${EXAMPLE_ID}/rerun`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
