import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

/** `ROUTE_MATRIX` slice for the `/api/transcripts` path family. */
export const TRANSCRIPTS_ROUTES: RouteMatrixEntry[] = [
  // prettier-ignore
  { name: "transcript list", method: "GET", path: "/api/transcripts", surface: "api", public: false, tenancy: "tenant" },
  // prettier-ignore
  { name: "transcript delete", method: "DELETE", path: `/api/transcripts/${EXAMPLE_ID}`, surface: "api", public: false, tenancy: "tenant" },
  {
    name: "transcript detail",
    method: "GET",
    path: `/api/transcripts/${EXAMPLE_ID}`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "transcript speakers",
    method: "GET",
    path: `/api/transcripts/${EXAMPLE_ID}/speakers`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "transcript action item state",
    method: "PUT",
    path: `/api/transcripts/${EXAMPLE_ID}/action-items/0/state`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "transcript action item task create",
    method: "POST",
    path: `/api/transcripts/${EXAMPLE_ID}/action-items/0/task`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "transcript action item task remove",
    method: "DELETE",
    path: `/api/transcripts/${EXAMPLE_ID}/action-items/0/task`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "transcript speaker assign",
    method: "PUT",
    path: `/api/transcripts/${EXAMPLE_ID}/speakers/SPEAKER_00`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "transcript speaker candidates",
    method: "GET",
    path: `/api/transcripts/${EXAMPLE_ID}/speaker-candidates`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
];
