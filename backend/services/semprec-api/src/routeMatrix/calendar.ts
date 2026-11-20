import type { RouteMatrixEntry } from "../routeMatrix.js";
import { EXAMPLE_ID } from "./exampleId.js";

export const CALENDAR_ROUTES: RouteMatrixEntry[] = [
  {
    name: "calendar timeline",
    method: "GET",
    path: "/api/calendar/timeline?from=2026-10-16&to=2026-10-16",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "calendar agenda",
    method: "GET",
    path: "/api/calendar/agenda?from=2026-10-16&direction=forward",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "calendar item duplicate",
    method: "POST",
    path: `/api/calendar/items/${EXAMPLE_ID}/duplicate`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "calendar cancellation impact",
    method: "GET",
    path: `/api/calendar/calendars/${EXAMPLE_ID}/cancellation-impact`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "calendar invitation respond",
    method: "POST",
    path: `/api/calendar/invitations/${EXAMPLE_ID}/respond`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "calendar reminders",
    method: "GET",
    path: "/api/calendar/reminders?from=2026-10-16T00%3A00%3A00Z",
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "calendar account sync",
    method: "POST",
    path: `/api/accounts/${EXAMPLE_ID}/calendars/sync`,
    surface: "api",
    public: false,
    tenancy: "tenant",
  },
  {
    name: "Google Calendar webhook",
    method: "POST",
    path: "/api/calendar/google/webhook",
    surface: "api",
    public: true,
    tenancy: "anonymous",
    publicReason:
      "Google Calendar itself calls this with no session to deliver push channel notifications; the channel token (a random secret stored per channel, checked in constant time) is the receiver's own authenticity check, the tenant comes from route_google_calendar_channel, and the handler only queues a sync pass.",
  },
  {
    name: "Microsoft Graph calendar webhook",
    method: "POST",
    path: "/api/calendar/graph/webhook",
    surface: "api",
    public: true,
    tenancy: "anonymous",
    publicReason:
      "Microsoft Graph itself calls this with no session to deliver subscription validation and change notifications; each notification's clientState (checked in constant time) is the receiver's own authenticity check, the tenant comes from route_graph_calendar_subscription, and the handler only queues a sync pass.",
  },
];
